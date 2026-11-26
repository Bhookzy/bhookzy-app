'use strict';
const { formatDateTime, inr } = require('./util');

const PAYMENT_LABEL = {
  cod: 'Cash on Delivery',
  upi_whatsapp: 'UPI / PhonePe / GPay (pay via WhatsApp)',
  razorpay: 'Online payment',
};

const waLink = (number, text) => `https://wa.me/${String(number).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

/**
 * Order message sent to the Bhookzy WhatsApp number. Built on the server from the SAVED order,
 * so the text always matches what is in the database.
 * `compact` drops per-line detail for very long orders (some phones limit URL length).
 */
function buildOrderMessage(order, items, { compact = false } = {}) {
  const L = [];
  L.push('*NEW ORDER — BHOOKZY*', '');
  L.push(`*Order ID:* ${order.order_code}`);
  L.push(`*Restaurant:* ${order.restaurant_name}`, '');
  L.push(`*Customer:* ${order.customer_name}`);
  L.push(`*Mobile:* ${order.customer_phone}`);
  L.push(`*Address:* ${[order.address_house, order.address_area].filter(Boolean).join(', ')}${order.address_tag ? ` [${order.address_tag}]` : ''}`);
  if (order.address_landmark) L.push(`*Landmark:* ${order.address_landmark}`);
  if (order.delivery_instructions) L.push(`*Instructions:* ${order.delivery_instructions}`);
  L.push('', '*ORDER DETAILS:*', '');
  items.forEach((it, i) => {
    const name = it.variant_label && it.variant_label !== 'Regular' ? `${it.product_name} (${it.variant_label})` : it.product_name;
    L.push(`${i + 1}. ${name} x ${it.qty} — ${inr(it.line_total)}`);
    if (!compact) {
      const extras = [];
      if (it.spice) extras.push(`Spice: ${it.spice}`);
      const addons = Array.isArray(it.addons) ? it.addons : [];
      if (addons.length) extras.push(`Add-ons: ${addons.map((a) => `${a.name} (+${inr(a.price)})`).join(', ')}`);
      if (it.qty > 1) extras.push(`${inr(it.unit_price)} each`);
      if (extras.length) L.push(`    ${extras.join(' | ')}`);
    }
  });
  L.push('', `Subtotal: ${inr(order.subtotal)}`);
  if (order.coupon_discount > 0) L.push(`Discount${order.coupon_code ? ` (${order.coupon_code})` : ''}: -${inr(order.coupon_discount)}`);
  L.push(`Delivery: ${order.delivery_fee === 0 ? 'FREE' : inr(order.delivery_fee)}`);
  L.push(`*Total: ${inr(order.total)}*`, '');
  L.push(`Payment: ${PAYMENT_LABEL[order.payment_method] || order.payment_method}${order.payment_method === 'cod' ? '' : ' — payment pending'}`);
  L.push(`Date: ${formatDateTime(order.created_at)}`, '');
  L.push(order.payment_method === 'cod' ? 'Please confirm this order.' : 'Please confirm this order and share the UPI ID / QR to pay.');
  return L.join('\n');
}

/** Pick the full message, falling back to the compact one if the URL would be too long for a phone. */
function buildOrderWhatsApp(number, order, items) {
  let text = buildOrderMessage(order, items);
  let url = waLink(number, text);
  if (url.length > 3800) { text = buildOrderMessage(order, items, { compact: true }); url = waLink(number, text); }
  return { url, text };
}

const STATUS_MESSAGES = {
  confirmed: (o) => `Hi ${o.customer_name}, your Bhookzy order ${o.order_code} (${o.restaurant_name}) is *confirmed*. Total: ${inr(o.total)}. Thank you!`,
  preparing: (o) => `Hi ${o.customer_name}, your order ${o.order_code} is being *prepared* fresh in the kitchen.`,
  ready_for_pickup: (o) => `Hi ${o.customer_name}, your order ${o.order_code} is *ready* and will be picked up for delivery shortly.`,
  out_for_delivery: (o) => `Hi ${o.customer_name}, your order ${o.order_code} is *out for delivery*. Please keep ${inr(o.total)} ready if paying cash.`,
  delivered: (o) => `Hi ${o.customer_name}, your order ${o.order_code} has been *delivered*. Thank you for ordering with Bhookzy! We'd love your feedback.`,
  cancelled: (o) => `Hi ${o.customer_name}, sorry — your order ${o.order_code} has been *cancelled*${o.cancel_reason ? `: ${o.cancel_reason}` : ''}. Please contact us if you need help.`,
  default: (o) => `Hi ${o.customer_name}, this is Bhookzy regarding your order ${o.order_code}.`,
};

function customerChatLink(order, kind, extra = {}) {
  const phone = `91${order.customer_phone}`;
  if (kind === 'payment') {
    const upi = extra.upi_id ? `UPI ID: *${extra.upi_id}*\n` : '';
    return waLink(phone, `Hi ${order.customer_name}, please pay *${inr(order.total)}* for Bhookzy order ${order.order_code}.\n${upi}After paying, please send the screenshot / transaction ID here. Thank you!`);
  }
  const fn = STATUS_MESSAGES[kind] || STATUS_MESSAGES.default;
  return waLink(phone, fn(order));
}

module.exports = { buildOrderMessage, buildOrderWhatsApp, customerChatLink, waLink, PAYMENT_LABEL };
