'use strict';
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { HttpError, badRequest, notFound, conflict, forbidden, generateOrderCode, randomToken } = require('./util');
const { quote, publicQuote } = require('./pricing');
const { getSettings } = require('./settings');
const { buildOrderWhatsApp, customerChatLink, PAYMENT_LABEL } = require('./whatsapp');

const STATUSES = ['new', 'pending_confirmation', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'cancelled'];
const FLOW = STATUSES.slice(0, 7);
const STATUS_LABEL = {
  new: 'New Order', pending_confirmation: 'Pending Confirmation', confirmed: 'Confirmed', preparing: 'Preparing',
  ready_for_pickup: 'Ready for Pickup', out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled',
};
// What the customer sees (new / pending collapse into one message — nothing is "confirmed" until the owner says so)
const CUSTOMER_LABEL = {
  new: 'Awaiting Owner Confirmation', pending_confirmation: 'Awaiting Owner Confirmation', confirmed: 'Confirmed',
  preparing: 'Preparing', ready_for_pickup: 'Ready', out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled',
};
const DUPLICATE_WINDOW_MIN = 3;
const MAX_ORDERS_PER_PHONE_PER_HOUR = 6;

function canTransition(from, to, role) {
  if (from === to) return false;
  if (to === 'cancelled') return from !== 'delivered' && from !== 'cancelled';
  if (from === 'cancelled') return role === 'owner' && to === 'pending_confirmation';
  if (from === 'delivered') return false;
  return FLOW.indexOf(to) > FLOW.indexOf(from);
}

// ---------------------------------------------------------------------------------------------------------
// Customer: create
// ---------------------------------------------------------------------------------------------------------
async function loadOrderParts(client, orderId) {
  const order = (await client.query(
    `SELECT o.*, p.status AS payment_status, p.amount_received, p.paid_at, p.reference AS payment_reference
       FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1`, [orderId])).rows[0];
  const items = (await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId])).rows;
  const history = (await client.query('SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id', [orderId])).rows;
  return { order, items, history };
}

async function createOrder(input) {
  const settings = await getSettings();
  try {
    return await db.tx(async (client) => {
      // 1. Same idempotency key => same order (network retry / double tap)
      const replay = await client.query('SELECT id FROM orders WHERE idempotency_key = $1', [input.idempotency_key]);
      if (replay.rows[0]) return { ...(await presentCreated(client, replay.rows[0].id, settings)), replay: true };

      // 2. Authoritative pricing
      const q = await quote(client, {
        restaurant_id: input.restaurant_id, items: input.items, coupon_code: input.coupon_code,
        zone_id: input.zone_id, phone: input.customer.phone, payment_method: input.payment_method,
      });
      if (q.coupon_error) throw badRequest(q.coupon_error, 'COUPON_INVALID', { quote: publicQuote(q) });
      if (!q.can_order) throw conflict(q.blockers[0].message, q.blockers[0].code, { quote: publicQuote(q) });
      if (input.expected_total !== undefined && input.expected_total !== null && input.expected_total !== q.total) {
        throw conflict('Some prices or charges changed. Please review your updated bill.', 'PRICE_CHANGED', { quote: publicQuote(q) });
      }

      const area = q.zone && !q.zone.is_custom_area ? q.zone.name : (input.address.area || '');
      if (area.length < 2) throw badRequest('Please enter your area / locality.', 'VALIDATION', { 'address.area': 'Required' });

      // 3. Abuse / accidental double-submit guards
      const dupe = await client.query(
        `SELECT id FROM orders WHERE customer_phone = $1 AND items_hash = $2 AND restaurant_id = $3 AND status <> 'cancelled'
            AND created_at > now() - ($4 || ' minutes')::interval ORDER BY created_at DESC LIMIT 1`,
        [input.customer.phone, q.items_hash, q.restaurant.id, String(DUPLICATE_WINDOW_MIN)]);
      if (dupe.rows[0]) return { ...(await presentCreated(client, dupe.rows[0].id, settings)), duplicate: true };
      const recent = (await client.query(
        `SELECT count(*)::int AS n FROM orders WHERE customer_phone = $1 AND created_at > now() - interval '1 hour'`, [input.customer.phone])).rows[0].n;
      if (recent >= MAX_ORDERS_PER_PHONE_PER_HOUR) throw new HttpError(429, 'Too many orders from this number. Please wait a while or call us.', 'TOO_MANY_ORDERS');

      // 4. Customer + order + lines + payment + history
      const cust = (await client.query(
        `INSERT INTO customers(phone, name, last_order_at) VALUES ($1,$2,now())
         ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, last_order_at = now() RETURNING id`,
        [input.customer.phone, input.customer.name])).rows[0];

      const token = randomToken(24);
      let orderId = null; let code = null;
      for (let attempt = 0; attempt < 10 && !orderId; attempt++) {
        code = generateOrderCode();
        const ins = await client.query(
          `INSERT INTO orders (order_code, restaurant_id, restaurant_name, customer_id, customer_name, customer_phone, address_tag,
              address_house, address_area, address_landmark, delivery_instructions, zone_id, status,
              mrp_total, subtotal, item_discount, coupon_code, coupon_discount, delivery_fee, total, est_ingredient_cost,
              payment_method, idempotency_key, items_hash, tracking_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (order_code) DO NOTHING RETURNING id`,
          [code, q.restaurant.id, q.restaurant.name, cust.id, input.customer.name, input.customer.phone, input.address.tag,
            input.address.house, area, input.address.landmark || null, input.address.instructions || null, q.zone?.id || null,
            q.mrp_total, q.subtotal, q.item_discount, q.coupon?.code || null, q.coupon_discount, q.delivery_fee, q.total, q.est_ingredient_cost,
            input.payment_method, input.idempotency_key, q.items_hash, token]);
        if (ins.rows[0]) orderId = ins.rows[0].id;
      }
      if (!orderId) throw new HttpError(503, 'Could not allocate an order number. Please try again.', 'ORDER_CODE_BUSY');

      for (const l of q.lines) {
        await client.query(
          `INSERT INTO order_items (order_id, restaurant_id, product_id, variant_id, product_name, variant_label, spice, addons,
              qty, unit_price, unit_mrp, unit_cost, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
          [orderId, q.restaurant.id, l.product_id, l.variant_id, l.product_name, l.variant_label, l.spice, JSON.stringify(l.addons),
            l.qty, l.unit_price, l.unit_mrp, l.unit_cost, l.line_total]);
      }
      await client.query(
        `INSERT INTO payments (order_id, method, provider, status, amount_due) VALUES ($1,$2,'manual','pending',$3)`,
        [orderId, input.payment_method, q.total]);
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note) VALUES ($1, NULL, 'new', 'Order placed on website')`, [orderId]);

      return { ...(await presentCreated(client, orderId, settings)), replay: false, duplicate: false };
    });
  } catch (err) {
    // two identical requests racing each other: the loser hits the unique index — return the winner's order
    if (err.code === '23505' && /idempotency_key/.test(err.constraint || err.message || '')) {
      const r = await db.query('SELECT id FROM orders WHERE idempotency_key = $1', [input.idempotency_key]);
      if (r.rows[0]) return { ...(await presentCreated(db, r.rows[0].id, settings)), replay: true };
    }
    throw err;
  }
}

async function presentCreated(client, orderId, settings) {
  const { order, items, history } = await loadOrderParts(client, orderId);
  const wa = buildOrderWhatsApp(settings.whatsapp.order_number, order, items);
  return { order: customerView(order, items, history, wa.url), tracking_token: order.tracking_token, whatsapp_url: wa.url, whatsapp_text: wa.text };
}

// ---------------------------------------------------------------------------------------------------------
// Customer: view / track (no cost, no internal notes, no tokens)
// ---------------------------------------------------------------------------------------------------------
function customerView(order, items, history, whatsappUrl) {
  const awaiting = order.status === 'new' || order.status === 'pending_confirmation';
  const timeline = [];
  const seen = new Set();
  for (const h of history) {
    const label = CUSTOMER_LABEL[h.to_status];
    const key = label;
    if (seen.has(key) && h.to_status !== 'cancelled') continue;
    seen.add(key);
    timeline.push({ status: h.to_status, label: h.to_status === 'new' ? 'Order placed' : label, at: h.created_at });
  }
  return {
    order_id: order.order_code,
    restaurant: order.restaurant_name,
    status: order.status,
    status_label: CUSTOMER_LABEL[order.status],
    awaiting_confirmation: awaiting,
    created_at: order.created_at,
    items: items.map((i) => ({
      name: i.product_name, variant: i.variant_label, spice: i.spice,
      addons: (i.addons || []).map((a) => a.name), qty: i.qty, unit_price: i.unit_price, line_total: i.line_total,
    })),
    bill: {
      subtotal: order.subtotal, item_discount: order.item_discount, coupon_code: order.coupon_code, coupon_discount: order.coupon_discount,
      delivery_fee: order.delivery_fee, total: order.total,
    },
    payment: { method: order.payment_method, method_label: PAYMENT_LABEL[order.payment_method], status: order.payment_status },
    customer: { name: order.customer_name, phone: order.customer_phone },
    address: { tag: order.address_tag, house: order.address_house, area: order.address_area, landmark: order.address_landmark, instructions: order.delivery_instructions },
    cancel_reason: order.status === 'cancelled' ? order.cancel_reason : null,
    timeline,
    whatsapp_url: whatsappUrl,
  };
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Track by order code + (device token OR the mobile number used on the order). Always the same 404 on mismatch. */
async function trackOrder({ order_id, phone, token }) {
  const settings = await getSettings();
  const row = (await db.query('SELECT id, customer_phone, tracking_token FROM orders WHERE order_code = $1', [String(order_id).toUpperCase()])).rows[0];
  const ok = row && ((token && safeEq(token, row.tracking_token)) || (phone && safeEq(phone, row.customer_phone)));
  if (!ok) throw notFound('We could not find an order with those details.');
  const { order, items, history } = await loadOrderParts(db, row.id);
  const wa = buildOrderWhatsApp(settings.whatsapp.order_number, order, items);
  return customerView(order, items, history, wa.url);
}

async function lookupDeviceOrders(list) {
  const out = [];
  for (const { order_id, token } of list.slice(0, 20)) {
    try { out.push(await trackOrder({ order_id, token })); } catch (_) { /* order removed or token wrong: skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------------
/** Appends a restaurant scope condition for managers. `scope` = { all: true } | { all: false, restaurantIds: [...] } */
function scopeSql(scope, col, params) {
  if (scope.all) return '';
  params.push(scope.restaurantIds.length ? scope.restaurantIds : [0]);
  return ` AND ${col} = ANY($${params.length})`;
}

function dateRangeSql(from, to, col, params) {
  let sql = '';
  if (from) { params.push(from); sql += ` AND ${col} >= ($${params.length}::date)::timestamp AT TIME ZONE '${config.timezone}'`; }
  if (to) { params.push(to); sql += ` AND ${col} < (($${params.length}::date) + 1)::timestamp AT TIME ZONE '${config.timezone}'`; }
  return sql;
}

function orderFilter(f, scope) {
  const params = [];
  let where = 'TRUE';
  where += scopeSql(scope, 'o.restaurant_id', params);
  if (f.restaurant_id) { params.push(f.restaurant_id); where += ` AND o.restaurant_id = $${params.length}`; }
  if (f.status) {
    if (f.status === 'active') where += ` AND o.status NOT IN ('delivered','cancelled')`;
    else { params.push(f.status); where += ` AND o.status = $${params.length}`; }
  }
  if (f.payment_status) { params.push(f.payment_status); where += ` AND p.status = $${params.length}`; }
  if (f.payment_method) { params.push(f.payment_method); where += ` AND p.method = $${params.length}`; }
  where += dateRangeSql(f.from, f.to, 'o.created_at', params);
  if (f.q) {
    const term = String(f.q).trim();
    params.push(`%${term.replace(/[%_\\]/g, '\\$&')}%`);
    const n = params.length;
    where += ` AND (o.order_code ILIKE $${n} OR o.customer_phone LIKE $${n} OR o.customer_name ILIKE $${n})`;
  }
  return { where, params };
}

async function listOrders(f, scope) {
  const { where, params } = orderFilter(f, scope);
  const total = (await db.query(`SELECT count(*)::int AS n FROM orders o JOIN payments p ON p.order_id = o.id WHERE ${where}`, params)).rows[0].n;
  const pageSize = Math.min(100, Math.max(1, f.page_size || 25));
  const page = Math.max(1, f.page || 1);
  params.push(pageSize, (page - 1) * pageSize);
  const rows = (await db.query(
    `SELECT o.id, o.order_code, o.created_at, o.customer_name, o.customer_phone, o.address_house, o.address_area, o.status, o.total,
            o.subtotal, o.coupon_discount, o.delivery_fee, o.restaurant_id, o.restaurant_name, o.payment_method,
            p.status AS payment_status, p.amount_received,
            (SELECT string_agg(oi.product_name || ' ×' || oi.qty, ', ' ORDER BY oi.id) FROM order_items oi WHERE oi.order_id = o.id) AS items_summary,
            (SELECT COALESCE(sum(oi.qty),0)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o JOIN payments p ON p.order_id = o.id
      WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  return { rows, total, page, page_size: pageSize };
}

async function getOrderAdmin(id, scope, { settings } = {}) {
  const st = settings || await getSettings();
  const { order, items, history } = await loadOrderParts(db, id);
  if (!order) throw notFound('Order not found');
  if (!scope.all && !scope.restaurantIds.includes(order.restaurant_id)) throw notFound('Order not found');
  const names = (await db.query(
    `SELECT h.id, u.full_name FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = $1`, [id])).rows;
  const nm = new Map(names.map((n) => [n.id, n.full_name]));
  const profit = order.subtotal - order.coupon_discount - order.est_ingredient_cost;
  return {
    ...order,
    tracking_token: undefined, idempotency_key: undefined, items_hash: undefined,
    items,
    history: history.map((h) => ({ ...h, by: nm.get(h.id) || null })),
    status_label: STATUS_LABEL[order.status],
    allowed_next: STATUSES.filter((s) => canTransitionForView(order.status, s)),
    estimated_margin: profit,   // food revenue after coupons minus ingredient cost — NOT net profit
    links: {
      customer_whatsapp: customerChatLink(order, order.status),
      payment_request: customerChatLink(order, 'payment', { upi_id: st.payment.upi_id }),
    },
  };
}
const canTransitionForView = (from, to) => canTransition(from, to, 'owner');

async function changeStatus(id, { to, note, cancel_reason, collect_cod }, user, scope) {
  return db.tx(async (client) => {
    const cur = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur || (!scope.all && !scope.restaurantIds.includes(cur.restaurant_id))) throw notFound('Order not found');
    if (!canTransition(cur.status, to, user.role)) {
      throw conflict(`Cannot move an order from "${STATUS_LABEL[cur.status]}" to "${STATUS_LABEL[to]}".`, 'BAD_TRANSITION');
    }
    if (to === 'cancelled' && !(cancel_reason && cancel_reason.trim())) throw badRequest('Please give a reason for cancelling (the customer will see it).', 'REASON_REQUIRED');
    const sets = ['status = $2'];
    if (to === 'confirmed') sets.push('confirmed_at = COALESCE(confirmed_at, now())');
    if (to === 'delivered') sets.push('delivered_at = now()');
    if (to === 'cancelled') sets.push('cancelled_at = now()', 'cancel_reason = $3');
    if (cur.status === 'cancelled') sets.push('cancelled_at = NULL', 'cancel_reason = NULL');
    await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, to === 'cancelled' ? [id, to, cancel_reason.trim()] : [id, to]);
    await client.query(
      'INSERT INTO order_status_history(order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)',
      [id, cur.status, to, user.id, (to === 'cancelled' ? cancel_reason : note) || null]);
    // Cash is only recorded when the owner explicitly says it was collected — never automatically.
    if (to === 'delivered' && collect_cod) {
      const pay = (await client.query('SELECT * FROM payments WHERE order_id = $1 FOR UPDATE', [id])).rows[0];
      if (pay.method === 'cod' && pay.status !== 'paid') {
        await client.query(
          `UPDATE payments SET status='paid', amount_received = amount_due, paid_at = now(), recorded_by = $2, reference = COALESCE(reference,'Cash collected on delivery') WHERE order_id = $1`,
          [id, user.id]);
      }
    }
    return { id, from: cur.status, to };
  });
}

async function updatePayment(id, { status, reference, notes }, user, scope) {
  return db.tx(async (client) => {
    const o = (await client.query('SELECT id, restaurant_id, total, status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o || (!scope.all && !scope.restaurantIds.includes(o.restaurant_id))) throw notFound('Order not found');
    if (status === 'paid' && o.status === 'cancelled') throw conflict('This order is cancelled. Mark the payment as refunded or leave it pending.', 'ORDER_CANCELLED');
    const received = status === 'paid' ? o.total : status === 'pending' || status === 'failed' ? 0 : undefined;
    await client.query(
      `UPDATE payments SET status = $2, amount_received = COALESCE($3, amount_received),
              paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, now()) WHEN $2 IN ('pending','failed') THEN NULL ELSE paid_at END,
              reference = COALESCE($4, reference), notes = COALESCE($5, notes), recorded_by = $6
        WHERE order_id = $1`, [id, status, received ?? null, reference || null, notes || null, user.id]);
    return { id, status };
  });
}

async function addNote(id, note, user, scope) {
  const o = (await db.query('SELECT id, restaurant_id, internal_notes FROM orders WHERE id = $1', [id])).rows[0];
  if (!o || (!scope.all && !scope.restaurantIds.includes(o.restaurant_id))) throw notFound('Order not found');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `[${stamp} UTC • ${user.full_name}] ${note}`;
  await db.query(`UPDATE orders SET internal_notes = CASE WHEN internal_notes IS NULL OR internal_notes = '' THEN $2 ELSE internal_notes || E'\\n' || $2 END WHERE id = $1`, [id, line]);
  return { id };
}

module.exports = {
  STATUSES, STATUS_LABEL, CUSTOMER_LABEL, canTransition, createOrder, trackOrder, lookupDeviceOrders,
  listOrders, orderFilter, getOrderAdmin, changeStatus, updatePayment, addNote, scopeSql, dateRangeSql,
};
