'use strict';
// Sales analytics. Every number comes from the orders / payments tables and is scoped to what the admin may see.
//
// METRIC DEFINITIONS (all by the date the order was PLACED, in the business time zone):
//   gross_order_value   total of every order placed, including cancelled ones        = pending + confirmed + delivered + cancelled
//   pending_value       status New / Pending Confirmation (owner has not accepted yet)
//   confirmed_value     status Confirmed / Preparing / Ready / Out for Delivery / Delivered  (accepted and not cancelled)
//   in_progress_value   confirmed_value minus delivered
//   delivered_sales     total billed on Delivered orders — the "real sales" number
//   cancelled_value     status Cancelled
//   collected_revenue   money actually recorded as received (payment status Paid) on non-cancelled orders
//   outstanding         Delivered orders whose payment has not been recorded as Paid yet
//   net_sales           delivered food revenue after coupons = sum(subtotal - coupon_discount) on Delivered orders
//   est_margin          net_sales minus ingredient cost. NOT profit: excludes delivery cost, packaging, commissions, taxes, wages.
const db = require('../db');
const config = require('../config');
const { badRequest, todayStr } = require('./util');
const { scopeSql, dateRangeSql } = require('./orders');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PENDING = `('new','pending_confirmation')`;
const IN_PROGRESS = `('confirmed','preparing','ready_for_pickup','out_for_delivery')`;

function resolveRange({ range = 'today', from, to } = {}) {
  const t = todayStr();
  switch (range) {
    case 'today': return { range, from: t, to: t, label: 'Today' };
    case 'yesterday': return { range, from: todayStr(-1), to: todayStr(-1), label: 'Yesterday' };
    case 'last7': return { range, from: todayStr(-6), to: t, label: 'Last 7 days' };
    case 'last30': return { range, from: todayStr(-29), to: t, label: 'Last 30 days' };
    case 'this_month': return { range, from: `${t.slice(0, 8)}01`, to: t, label: 'This month' };
    case 'custom': {
      if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw badRequest('Choose a start and end date.', 'BAD_RANGE');
      if (from > to) throw badRequest('The start date must be before the end date.', 'BAD_RANGE');
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 400) throw badRequest('Please choose a range of 400 days or less.', 'BAD_RANGE');
      return { range, from, to, label: `${from} → ${to}` };
    }
    default: throw badRequest('Unknown date range.', 'BAD_RANGE');
  }
}

function baseWhere(scope, { restaurantId, from, to }, params) {
  let w = 'TRUE';
  w += scopeSql(scope, 'o.restaurant_id', params);
  if (restaurantId) { params.push(restaurantId); w += ` AND o.restaurant_id = $${params.length}`; }
  if (from || to) w += dateRangeSql(from, to, 'o.created_at', params);
  return w;
}

async function summary(scope, opts) {
  const params = [];
  const where = baseWhere(scope, opts, params);
  const r = (await db.query(
    `SELECT
       count(*)::int                                                                   AS orders_total,
       count(*) FILTER (WHERE o.status IN ${PENDING})::int                              AS pending_orders,
       count(*) FILTER (WHERE o.status = 'confirmed')::int                              AS confirmed_orders,
       count(*) FILTER (WHERE o.status = 'preparing')::int                              AS preparing_orders,
       count(*) FILTER (WHERE o.status = 'ready_for_pickup')::int                       AS ready_orders,
       count(*) FILTER (WHERE o.status = 'out_for_delivery')::int                       AS out_for_delivery_orders,
       count(*) FILTER (WHERE o.status = 'delivered')::int                              AS delivered_orders,
       count(*) FILTER (WHERE o.status = 'cancelled')::int                              AS cancelled_orders,
       COALESCE(sum(o.total), 0)::int                                                   AS gross_order_value,
       COALESCE(sum(o.total) FILTER (WHERE o.status IN ${PENDING}), 0)::int             AS pending_value,
       COALESCE(sum(o.total) FILTER (WHERE o.status IN ${IN_PROGRESS}), 0)::int         AS in_progress_value,
       COALESCE(sum(o.total) FILTER (WHERE o.status = 'delivered'), 0)::int             AS delivered_sales,
       COALESCE(sum(o.total) FILTER (WHERE o.status = 'cancelled'), 0)::int             AS cancelled_value,
       COALESCE(sum(o.subtotal) FILTER (WHERE o.status = 'delivered'), 0)::int          AS delivered_items_total,
       COALESCE(sum(o.coupon_discount) FILTER (WHERE o.status = 'delivered'), 0)::int   AS delivered_coupon_discounts,
       COALESCE(sum(o.item_discount) FILTER (WHERE o.status = 'delivered'), 0)::int     AS delivered_menu_discounts,
       COALESCE(sum(o.delivery_fee) FILTER (WHERE o.status = 'delivered'), 0)::int      AS delivered_delivery_charges,
       COALESCE(sum(o.est_ingredient_cost) FILTER (WHERE o.status = 'delivered'), 0)::int AS delivered_ingredient_cost,
       COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::int            AS active_order_value,
       count(*) FILTER (WHERE o.status <> 'cancelled')::int                             AS active_orders,
       COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled'), 0)::int                          AS collected_revenue,
       COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled' AND p.method = 'cod'), 0)::int      AS cod_collected,
       COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled' AND p.method <> 'cod'), 0)::int     AS online_collected,
       COALESCE(sum(o.total - p.amount_received) FILTER (WHERE o.status = 'delivered' AND p.status <> 'paid'), 0)::int                 AS outstanding
     FROM orders o JOIN payments p ON p.order_id = o.id WHERE ${where}`, params)).rows[0];

  const confirmed_value = r.in_progress_value + r.delivered_sales;
  const net_sales = r.delivered_items_total - r.delivered_coupon_discounts;
  return {
    ...r,
    confirmed_value,
    net_sales,
    est_margin: net_sales - r.delivered_ingredient_cost,
    avg_order_value: r.active_orders ? Math.round(r.active_order_value / r.active_orders) : 0,
  };
}

async function customerStats(scope, restaurantId) {
  const params = [];
  let where = 'TRUE' + scopeSql(scope, 'o.restaurant_id', params);
  if (restaurantId) { params.push(restaurantId); where += ` AND o.restaurant_id = $${params.length}`; }
  const r = (await db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE n >= 2)::int AS repeat
       FROM (SELECT o.customer_id, count(*) FILTER (WHERE o.status <> 'cancelled') AS n FROM orders o WHERE ${where} GROUP BY o.customer_id) t`, params)).rows[0];
  return { total_customers: r.total, repeat_customers: r.repeat };
}

async function statusSnapshot(scope, restaurantId) {
  const params = [];
  let where = `o.status NOT IN ('delivered','cancelled')` + scopeSql(scope, 'o.restaurant_id', params);
  if (restaurantId) { params.push(restaurantId); where += ` AND o.restaurant_id = $${params.length}`; }
  const rows = (await db.query(`SELECT o.status, count(*)::int AS n FROM orders o WHERE ${where} GROUP BY o.status`, params)).rows;
  return Object.fromEntries(rows.map((x) => [x.status, x.n]));
}

/** "Today / this month / lifetime" cards: delivered sales, independent of the selected filter. */
async function fixedTotals(scope, restaurantId) {
  const t = todayStr();
  const out = {};
  for (const [key, from, to] of [['today', t, t], ['month', `${t.slice(0, 8)}01`, t], ['lifetime', null, null]]) {
    const s = await summary(scope, { restaurantId, from, to });
    out[key] = { delivered_sales: s.delivered_sales, net_sales: s.net_sales, gross_sales: s.delivered_items_total, orders: s.delivered_orders };
  }
  return out;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10);
}

async function series(scope, { restaurantId, from, to, granularity }) {
  let start; const end = to;
  if (granularity === 'week') start = mondayOf(addDays(to, -7 * 11));
  else if (granularity === 'month') { const d = new Date(`${to.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 11); start = d.toISOString().slice(0, 10); }
  else { start = from; if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) start = addDays(to, -92); }
  const unit = { day: 'day', week: 'week', month: 'month' }[granularity] || 'day';
  const params = [config.timezone];
  const where = baseWhere(scope, { restaurantId, from: start, to: end }, params);
  const rows = (await db.query(
    `SELECT to_char(date_trunc('${unit}', o.created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS bucket,
            count(*) FILTER (WHERE o.status <> 'cancelled')::int AS orders,
            count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
            COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS order_value,
            COALESCE(sum(o.total) FILTER (WHERE o.status = 'delivered'), 0)::int AS delivered_sales
       FROM orders o WHERE ${where} GROUP BY 1 ORDER BY 1`, params)).rows;
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const out = [];
  if (unit === 'day') for (let d = start; d <= end; d = addDays(d, 1)) out.push(byBucket.get(d) || { bucket: d, orders: 0, cancelled: 0, order_value: 0, delivered_sales: 0 });
  else if (unit === 'week') for (let d = start; d <= end; d = addDays(d, 7)) out.push(byBucket.get(d) || { bucket: d, orders: 0, cancelled: 0, order_value: 0, delivered_sales: 0 });
  else {
    const d = new Date(`${start}T00:00:00Z`);
    while (d.toISOString().slice(0, 10) <= end) { const k = d.toISOString().slice(0, 10); out.push(byBucket.get(k) || { bucket: k, orders: 0, cancelled: 0, order_value: 0, delivered_sales: 0 }); d.setUTCMonth(d.getUTCMonth() + 1); }
  }
  return out;
}

async function paymentMix(scope, opts) {
  const params = [];
  const where = baseWhere(scope, opts, params) + ` AND o.status <> 'cancelled'`;
  return (await db.query(
    `SELECT p.method, count(*)::int AS orders, COALESCE(sum(o.total), 0)::int AS value,
            COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid'), 0)::int AS collected
       FROM orders o JOIN payments p ON p.order_id = o.id WHERE ${where} GROUP BY p.method ORDER BY value DESC`, params)).rows;
}

async function topProducts(scope, opts, limit = 10) {
  const params = [];
  const where = baseWhere(scope, opts, params) + ` AND o.status <> 'cancelled'`;
  params.push(limit);
  return (await db.query(
    `SELECT oi.product_name AS name, oi.restaurant_id, sum(oi.qty)::int AS qty, sum(oi.line_total)::int AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${where}
      GROUP BY oi.product_name, oi.restaurant_id ORDER BY qty DESC, revenue DESC LIMIT $${params.length}`, params)).rows;
}

async function byRestaurant(scope, opts) {
  const params = [];
  const where = baseWhere(scope, { ...opts, restaurantId: null }, params);
  return (await db.query(
    `SELECT o.restaurant_id, o.restaurant_name AS name,
            count(*)::int AS orders,
            count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered_orders,
            COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS order_value,
            COALESCE(sum(o.total) FILTER (WHERE o.status = 'delivered'), 0)::int AS delivered_sales,
            COALESCE(sum(o.subtotal - o.coupon_discount - o.est_ingredient_cost) FILTER (WHERE o.status = 'delivered'), 0)::int AS est_margin,
            COALESCE(sum(o.total) FILTER (WHERE o.status = 'cancelled'), 0)::int AS cancelled_value
       FROM orders o WHERE ${where} GROUP BY o.restaurant_id, o.restaurant_name ORDER BY delivered_sales DESC, order_value DESC`, params)).rows;
}

async function dailyTable(scope, opts) {
  const params = [config.timezone];
  const where = baseWhere(scope, opts, params);
  return (await db.query(
    `SELECT to_char((o.created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS date,
            count(*)::int AS orders,
            count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered_orders,
            count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_orders,
            COALESCE(sum(o.total), 0)::int AS gross_order_value,
            COALESCE(sum(o.total) FILTER (WHERE o.status IN ${PENDING}), 0)::int AS pending_value,
            COALESCE(sum(o.total) FILTER (WHERE o.status IN ${IN_PROGRESS}), 0)::int AS in_progress_value,
            COALESCE(sum(o.total) FILTER (WHERE o.status = 'delivered'), 0)::int AS delivered_sales,
            COALESCE(sum(o.total) FILTER (WHERE o.status = 'cancelled'), 0)::int AS cancelled_value,
            COALESCE(sum(o.coupon_discount) FILTER (WHERE o.status = 'delivered'), 0)::int AS coupon_discounts,
            COALESCE(sum(o.delivery_fee) FILTER (WHERE o.status = 'delivered'), 0)::int AS delivery_charges,
            COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled'), 0)::int AS collected,
            COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled' AND p.method = 'cod'), 0)::int AS cod_collected,
            COALESCE(sum(p.amount_received) FILTER (WHERE p.status = 'paid' AND o.status <> 'cancelled' AND p.method <> 'cod'), 0)::int AS online_collected,
            COALESCE(sum(o.total - p.amount_received) FILTER (WHERE o.status = 'delivered' AND p.status <> 'paid'), 0)::int AS outstanding
       FROM orders o JOIN payments p ON p.order_id = o.id WHERE ${where} GROUP BY 1 ORDER BY 1 DESC`, params)).rows;
}

module.exports = { resolveRange, summary, customerStats, statusSnapshot, fixedTotals, series, paymentMix, topProducts, byRestaurant, dailyTable, baseWhere };
