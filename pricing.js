'use strict';
// The ONLY place where order amounts are calculated. Prices always come from the database, never from the browser.
const crypto = require('crypto');
const { badRequest, conflict, inr } = require('./util');
const { getSettings } = require('./settings');
const { loadRestaurants, isAvailableNow, isOrderable } = require('./catalog');

const MAX_LINES = 40;
const MAX_QTY = 25;

/** Merge identical lines and bound sizes. Input is untrusted. */
function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Your bag is empty.', 'EMPTY_CART');
  const merged = new Map();
  for (const it of items) {
    const addonIds = [...new Set((it.addon_ids || []).map(Number))].sort((a, b) => a - b);
    const key = [it.product_id, it.variant_id, it.spice || '', addonIds.join(',')].join('|');
    const prev = merged.get(key);
    if (prev) prev.qty += it.qty; else merged.set(key, { product_id: it.product_id, variant_id: it.variant_id, spice: it.spice || '', addon_ids: addonIds, qty: it.qty });
  }
  const out = [...merged.values()];
  if (out.length > MAX_LINES) throw badRequest(`Too many different items in one order (max ${MAX_LINES}).`, 'TOO_MANY_ITEMS');
  for (const l of out) if (l.qty > MAX_QTY) throw badRequest(`You can order at most ${MAX_QTY} of one item.`, 'QTY_LIMIT');
  return out;
}

async function evaluateCoupon(db, code, { subtotal, restaurantId, phone }) {
  const { rows } = await db.query(
    `SELECT * FROM coupons WHERE upper(code) = upper($1) AND is_active`, [String(code).trim()]);
  const c = rows[0];
  const fail = (message) => ({ ok: false, message });
  if (!c) return fail('Invalid coupon code.');
  const now = new Date();
  if (c.starts_at && new Date(c.starts_at) > now) return fail('This coupon is not active yet.');
  if (c.expires_at && new Date(c.expires_at) <= now) return fail('This coupon has expired.');
  if (c.restaurant_id && Number(c.restaurant_id) !== Number(restaurantId)) return fail('This coupon is not valid for this restaurant.');
  if (subtotal < c.min_order) return fail(`Add ${inr(c.min_order - subtotal)} more to use ${c.code} (minimum order ${inr(c.min_order)}).`);
  if (c.usage_limit) {
    const used = (await db.query(`SELECT count(*)::int AS n FROM orders WHERE upper(coupon_code) = upper($1) AND status <> 'cancelled'`, [c.code])).rows[0].n;
    if (used >= c.usage_limit) return fail('This coupon has been fully redeemed.');
  }
  if (c.per_customer_limit && phone) {
    const used = (await db.query(
      `SELECT count(*)::int AS n FROM orders WHERE upper(coupon_code) = upper($1) AND customer_phone = $2 AND status <> 'cancelled'`, [c.code, phone])).rows[0].n;
    if (used >= c.per_customer_limit) return fail('You have already used this coupon the maximum number of times.');
  }
  let discount = c.discount_type === 'flat' ? c.discount_value : Math.round((subtotal * c.discount_value) / 100);
  if (c.discount_type === 'percent' && c.max_discount) discount = Math.min(discount, c.max_discount);
  discount = Math.max(0, Math.min(discount, subtotal));
  return { ok: true, code: c.code, discount, description: c.description };
}

/**
 * Price a basket. `db` is a pg Pool or Client. Never throws for a bad coupon (returns coupon_error) —
 * callers decide whether that is fatal. Throws 400/409 for tampered or unavailable items.
 */
async function quote(db, { restaurant_id, items, coupon_code, zone_id, phone, payment_method }) {
  const settings = await getSettings();
  const lines = normaliseItems(items);

  const [restaurant] = await loadRestaurants({ ids: [restaurant_id] });
  if (!restaurant) throw badRequest('This restaurant is not available.', 'RESTAURANT_UNAVAILABLE');

  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const prows = (await db.query(
    `SELECT p.*, COALESCE(a.in_stock, TRUE) AS in_stock, a.available_from, a.available_to, a.unavailable_until, c.is_active AS cat_active
       FROM products p
       JOIN restaurant_categories c ON c.id = p.category_id
       LEFT JOIN product_availability a ON a.product_id = p.id
      WHERE p.id = ANY($1)`, [productIds])).rows;
  const pMap = new Map(prows.map((p) => [p.id, p]));
  const vMap = new Map((await db.query('SELECT * FROM product_variants WHERE product_id = ANY($1)', [productIds])).rows.map((v) => [v.id, v]));
  const aMap = new Map((await db.query('SELECT * FROM product_addons WHERE product_id = ANY($1)', [productIds])).rows.map((a) => [a.id, a]));

  const priced = [];
  const unavailable = [];
  for (const l of lines) {
    const p = pMap.get(l.product_id);
    if (!p || p.restaurant_id !== restaurant.id) throw badRequest('Your bag has an item that is not on this restaurant\'s menu. Please refresh.', 'ITEM_INVALID');
    const v = vMap.get(l.variant_id);
    if (!v || v.product_id !== p.id) throw badRequest(`"${p.name}" has changed. Please refresh your bag.`, 'VARIANT_INVALID');
    if (!p.is_active || !p.cat_active || !v.is_active || !isAvailableNow(p)) { unavailable.push({ product_id: p.id, name: p.name }); continue; }

    let spice = null;
    if (p.spice_options.length) {
      spice = l.spice || (p.spice_options.includes('Medium') ? 'Medium' : p.spice_options[0]);
      if (!p.spice_options.includes(spice)) throw badRequest(`Invalid spice level for "${p.name}".`, 'SPICE_INVALID');
    }
    const addons = l.addon_ids.map((id) => {
      const a = aMap.get(id);
      if (!a || a.product_id !== p.id || !a.is_active) throw badRequest(`An add-on for "${p.name}" is no longer available.`, 'ADDON_INVALID');
      return { id: a.id, name: a.name, price: a.price, cost: a.cost };
    });
    const addonPrice = addons.reduce((s, a) => s + a.price, 0);
    const addonCost = addons.reduce((s, a) => s + a.cost, 0);
    const unit_price = v.price + addonPrice;
    priced.push({
      product_id: p.id, variant_id: v.id, product_name: p.name, variant_label: v.label, spice, addons, qty: l.qty,
      unit_price, unit_mrp: v.mrp + addonPrice, unit_cost: v.cost + addonCost, line_total: unit_price * l.qty,
      image_url: p.image_url,
    });
  }
  if (unavailable.length) {
    throw conflict(`Sorry, ${unavailable.map((u) => u.name).join(', ')} ${unavailable.length > 1 ? 'are' : 'is'} currently unavailable. Please remove ${unavailable.length > 1 ? 'them' : 'it'} from your bag.`, 'ITEM_UNAVAILABLE', { unavailable });
  }

  const subtotal = priced.reduce((s, l) => s + l.line_total, 0);
  const mrp_total = priced.reduce((s, l) => s + l.unit_mrp * l.qty, 0);
  const est_ingredient_cost = priced.reduce((s, l) => s + l.unit_cost * l.qty, 0);

  // ---- delivery zone, charge and minimum order (restaurant overrides zone, zone overrides store default)
  let zone;
  if (zone_id) {
    zone = (await db.query('SELECT * FROM delivery_zones WHERE id = $1 AND is_active', [zone_id])).rows[0];
    if (!zone) throw badRequest('Please choose a valid delivery area.', 'ZONE_INVALID');
  } else {
    zone = (await db.query('SELECT * FROM delivery_zones WHERE is_active ORDER BY is_default DESC, sort_order, id LIMIT 1')).rows[0];
  }
  const svc = settings.service;
  const charge = restaurant.delivery_charge ?? zone?.delivery_charge ?? svc.default_delivery_charge;
  const threshold = restaurant.free_delivery_above ?? zone?.free_delivery_threshold ?? svc.default_free_delivery_threshold;
  const delivery_fee = subtotal >= threshold ? 0 : charge;
  const min_order = Math.max(restaurant.min_order_value || 0, zone?.min_order_value || 0, svc.min_order_value || 0);

  // ---- coupon (applied to the item subtotal; delivery is never discounted)
  let coupon = null; let coupon_error = null;
  if (coupon_code && String(coupon_code).trim()) {
    const r = await evaluateCoupon(db, coupon_code, { subtotal, restaurantId: restaurant.id, phone });
    if (r.ok) coupon = r; else coupon_error = r.message;
  }
  const coupon_discount = coupon ? coupon.discount : 0;
  const total = subtotal - coupon_discount + delivery_fee;

  // ---- things that stop the order from being placed
  const blockers = [];
  if (!restaurant.orderable.ok) blockers.push({ code: restaurant.orderable.code, message: restaurant.orderable.message });
  if (subtotal < min_order) blockers.push({ code: 'MIN_ORDER', message: `Minimum order for ${restaurant.name} is ${inr(min_order)}. Add ${inr(min_order - subtotal)} more.` });
  if (payment_method === 'cod' && !settings.payment.cod_enabled) blockers.push({ code: 'PAYMENT_DISABLED', message: 'Cash on Delivery is currently unavailable.' });
  if (payment_method === 'upi_whatsapp' && !settings.payment.upi_whatsapp_enabled) blockers.push({ code: 'PAYMENT_DISABLED', message: 'UPI via WhatsApp is currently unavailable.' });

  const items_hash = crypto.createHash('sha256').update(JSON.stringify([restaurant.id, priced.map((l) => [l.product_id, l.variant_id, l.spice, l.addons.map((a) => a.id), l.qty])])).digest('hex');

  return {
    restaurant: { id: restaurant.id, name: restaurant.name, slug: restaurant.slug },
    zone: zone ? { id: zone.id, name: zone.name, is_custom_area: zone.is_custom_area } : null,
    lines: priced,
    mrp_total, subtotal, item_discount: mrp_total - subtotal,
    coupon: coupon ? { code: coupon.code, discount: coupon.discount, description: coupon.description } : null,
    coupon_error,
    coupon_discount, delivery_fee, total, est_ingredient_cost,
    free_delivery_threshold: threshold, delivery_charge: charge,
    amount_to_free_delivery: Math.max(0, threshold - subtotal),
    min_order, blockers, can_order: blockers.length === 0, items_hash,
  };
}

/** What the browser is allowed to see (no cost fields). */
function publicQuote(q) {
  return {
    restaurant: q.restaurant, zone: q.zone,
    lines: q.lines.map((l) => ({
      product_id: l.product_id, variant_id: l.variant_id, name: l.product_name, variant_label: l.variant_label, spice: l.spice,
      addons: l.addons.map((a) => ({ id: a.id, name: a.name, price: a.price })), qty: l.qty, unit_price: l.unit_price,
      unit_mrp: l.unit_mrp, line_total: l.line_total,
    })),
    mrp_total: q.mrp_total, subtotal: q.subtotal, item_discount: q.item_discount, coupon: q.coupon, coupon_error: q.coupon_error,
    coupon_discount: q.coupon_discount, delivery_fee: q.delivery_fee, total: q.total,
    free_delivery_threshold: q.free_delivery_threshold, delivery_charge: q.delivery_charge,
    amount_to_free_delivery: q.amount_to_free_delivery, min_order: q.min_order, blockers: q.blockers, can_order: q.can_order,
  };
}

module.exports = { quote, publicQuote, evaluateCoupon, normaliseItems, MAX_QTY };
