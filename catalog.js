'use strict';
// Builds the PUBLIC view of restaurants/menu. Ingredient cost, margins and other private fields are never selected here.
const db = require('../db');
const { getSettings } = require('./settings');
const { hoursMap, openStatus, inDailyWindow } = require('./hours');
const { fmt12, timeToMinutes } = require('./util');

function hoursSummary(map) {
  const open = [0, 1, 2, 3, 4, 5, 6].filter((d) => map[d] && !map[d].is_closed);
  if (!open.length) return 'Closed';
  const sample = map[open[0]];
  const same = open.every((d) => map[d].opens_at === sample.opens_at && map[d].closes_at === sample.closes_at);
  const range = `${fmt12(timeToMinutes(sample.opens_at))} – ${fmt12(timeToMinutes(sample.closes_at))}`;
  return same ? (open.length === 7 ? range : `${range} (${open.length} days)`) : 'See timings';
}

function isOrderable(r, status, svc) {
  if (!r.online_ordering_enabled) return { ok: false, code: 'ORDERING_DISABLED', message: `${r.name} is not taking online orders right now.` };
  if (!r.delivery_available) return { ok: false, code: 'DELIVERY_UNAVAILABLE', message: `${r.name} is not delivering right now.` };
  if (svc.temporarily_closed) return { ok: false, code: 'STORE_CLOSED', message: svc.closed_message || 'We are temporarily closed.' };
  if (!svc.accepting_orders) return { ok: false, code: 'NOT_ACCEPTING', message: 'We are not accepting new orders at the moment.' };
  if (svc.enforce_hours && !status.open) return { ok: false, code: 'OUTSIDE_HOURS', message: `${r.name} is closed. ${status.text.replace('Closed • ', '')}.` };
  return { ok: true };
}

async function loadRestaurants({ includeInactive = false, ids = null } = {}) {
  const settings = await getSettings();
  const params = [];
  let where = 'r.is_active';
  if (includeInactive) where = 'TRUE';
  if (ids) { params.push(ids); where += ` AND r.id = ANY($${params.length})`; }
  const { rows } = await db.query(
    `SELECT r.*, (SELECT count(*)::int FROM products p WHERE p.restaurant_id = r.id AND p.is_active) AS item_count
       FROM restaurants r WHERE ${where} ORDER BY r.sort_order, r.id`, params);
  const hrows = (await db.query('SELECT * FROM restaurant_hours WHERE restaurant_id = ANY($1)', [rows.map((r) => r.id)])).rows;
  const byR = {};
  for (const h of hrows) (byR[h.restaurant_id] ||= []).push(h);
  return rows.map((r) => {
    const map = hoursMap(byR[r.id], settings.hours);
    const status = openStatus(map);
    const orderable = isOrderable(r, status, settings.service);
    return { ...r, hours: map, status, orderable, hours_text: hoursSummary(map) };
  });
}

function publicRestaurant(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, cuisine_text: r.cuisine_text,
    logo_url: r.logo_url, cover_url: r.cover_url, address: r.address, phone: r.phone,
    delivery_available: r.delivery_available, min_order_value: r.min_order_value,
    delivery_charge: r.delivery_charge, free_delivery_above: r.free_delivery_above,
    prep_time_min: r.prep_time_min, est_delivery_min: r.est_delivery_min, est_delivery_max: r.est_delivery_max,
    online_ordering_enabled: r.online_ordering_enabled, is_featured: r.is_featured, sort_order: r.sort_order,
    rating: r.rating, rating_count_text: r.rating_count_text, item_count: r.item_count,
    open_now: r.status.open, status_text: r.status.text, hours_text: r.hours_text,
    orderable: r.orderable.ok, blocked_reason: r.orderable.ok ? null : r.orderable.message,
  };
}

async function loadPublicMenu() {
  const settings = await getSettings();
  const restaurants = (await loadRestaurants()).filter(Boolean);
  const rids = restaurants.map((r) => r.id);

  const cats = (await db.query(
    `SELECT id, restaurant_id, name, slug, image_url, sort_order FROM restaurant_categories
      WHERE is_active AND restaurant_id = ANY($1) ORDER BY sort_order, id`, [rids])).rows;
  const activeCat = new Set(cats.map((c) => c.id));

  const prods = (await db.query(
    `SELECT p.id, p.restaurant_id, p.category_id, p.name, p.description, p.keywords, p.image_url, p.food_type,
            p.is_bestseller, p.is_featured, p.prep_time_min, p.spice_options, p.sort_order,
            COALESCE(a.in_stock, TRUE) AS in_stock, a.available_from, a.available_to, a.unavailable_until
       FROM products p LEFT JOIN product_availability a ON a.product_id = p.id
      WHERE p.is_active AND p.restaurant_id = ANY($1)
      ORDER BY p.sort_order, p.id`, [rids])).rows.filter((p) => activeCat.has(p.category_id));
  const pids = prods.map((p) => p.id);

  const vars = (await db.query(
    `SELECT id, product_id, label, price, mrp, is_default FROM product_variants
      WHERE is_active AND product_id = ANY($1) ORDER BY sort_order, id`, [pids])).rows;
  const adds = (await db.query(
    `SELECT id, product_id, name, price FROM product_addons
      WHERE is_active AND product_id = ANY($1) ORDER BY sort_order, id`, [pids])).rows;
  const vBy = {}; for (const v of vars) (vBy[v.product_id] ||= []).push({ id: v.id, label: v.label, price: v.price, mrp: v.mrp, is_default: v.is_default });
  const aBy = {}; for (const a of adds) (aBy[a.product_id] ||= []).push({ id: a.id, name: a.name, price: a.price });

  const now = new Date();
  const products = prods.filter((p) => (vBy[p.id] || []).length > 0).map((p) => ({
    id: p.id, restaurant_id: p.restaurant_id, category_id: p.category_id, name: p.name, description: p.description,
    keywords: p.keywords, image_url: p.image_url, food_type: p.food_type, is_bestseller: p.is_bestseller,
    is_featured: p.is_featured, prep_time_min: p.prep_time_min, spice_options: p.spice_options,
    available: isAvailableNow(p, now), variants: vBy[p.id], addons: aBy[p.id] || [],
  }));

  const zones = (await db.query(
    `SELECT id, name, short_name, delivery_charge, free_delivery_threshold, min_order_value, is_default, is_custom_area
       FROM delivery_zones WHERE is_active ORDER BY sort_order, id`)).rows;
  const coupons = (await db.query(
    `SELECT code, description, discount_type, discount_value, max_discount, min_order, expires_at, restaurant_id
       FROM coupons WHERE is_active AND is_public AND (starts_at IS NULL OR starts_at <= now()) AND (expires_at IS NULL OR expires_at > now())
      ORDER BY id`)).rows;
  const reviews = (await db.query(
    `SELECT customer_name, rating, comment, created_at FROM reviews WHERE status = 'approved' ORDER BY created_at DESC LIMIT 12`)).rows;

  return {
    version: settings.menu_version,
    restaurants: restaurants.map(publicRestaurant),
    categories: cats,
    products,
    zones,
    coupons,
    reviews,
  };
}

function isAvailableNow(p, now = new Date()) {
  if (!p.in_stock) return false;
  if (p.unavailable_until && new Date(p.unavailable_until) > now) return false;
  return inDailyWindow(p.available_from, p.available_to, now);
}

module.exports = { loadRestaurants, publicRestaurant, loadPublicMenu, isAvailableNow, isOrderable };
