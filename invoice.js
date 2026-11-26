'use strict';
const { formatDateTime, inr } = require('./util');
const { PAYMENT_LABEL } = require('./whatsapp');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Printable invoice (customer-safe: no costs, no internal notes). Use the browser's Print → Save as PDF. */
function invoiceHtml(o, settings) {
  const b = settings.business;
  const rows = o.items.map((i, n) => {
    const name = i.variant_label && i.variant_label !== 'Regular' ? `${i.product_name} (${i.variant_label})` : i.product_name;
    const extra = [i.spice ? `Spice: ${i.spice}` : '', (i.addons || []).length ? `Add-ons: ${i.addons.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · ');
    return `<tr><td>${n + 1}</td><td>${esc(name)}${extra ? `<div class="sub">${esc(extra)}</div>` : ''}</td><td class="r">${i.qty}</td><td class="r">${inr(i.unit_price)}</td><td class="r">${inr(i.line_total)}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(o.order_code)}</title><meta name="robots" content="noindex">
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#141518;margin:0;background:#f4f1ec}
 .sheet{max-width:760px;margin:24px auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
 h1{margin:0;color:#E23744;font-size:26px} .muted{color:#6b6b6b} .row{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
 table{width:100%;border-collapse:collapse;margin-top:18px} th{background:#141518;color:#fff;text-align:left;padding:8px;font-size:12px}
 td{padding:8px;border-bottom:1px solid #eee;vertical-align:top} .r{text-align:right} .sub{font-size:12px;color:#777}
 .tot td{border:0;padding:3px 8px} .grand td{font-weight:800;font-size:16px;border-top:2px solid #141518}
 .badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#ECFDF5;color:#059669;font-weight:700;font-size:12px}
 button{background:#E23744;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
 @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;padding:0}.noprint{display:none}}
</style></head><body><div class="sheet">
 <div class="row"><div><h1>${esc(b.name)}</h1><div class="muted">${esc(b.tagline)}</div><div class="muted">${esc(b.address)}</div><div class="muted">${esc(b.phone)} · ${esc(b.email)}</div></div>
 <div style="text-align:right"><div style="font-size:20px;font-weight:800">INVOICE</div><div>${esc(o.order_code)}</div><div class="muted">${esc(formatDateTime(o.created_at))}</div><div class="badge">100% PURE VEG</div></div></div>
 <hr style="border:0;border-top:1px solid #eee;margin:18px 0">
 <div class="row"><div><strong>Bill to</strong><br>${esc(o.customer_name)}<br>${esc(o.customer_phone)}<br>${esc([o.address_house, o.address_area].filter(Boolean).join(', '))}${o.address_landmark ? `<br>Landmark: ${esc(o.address_landmark)}` : ''}</div>
 <div><strong>Prepared by</strong><br>${esc(o.restaurant_name)}<br><span class="muted">Payment: ${esc(PAYMENT_LABEL[o.payment_method] || o.payment_method)} (${esc(o.payment_status)})</span><br><span class="muted">Status: ${esc(o.status_label)}</span></div></div>
 <table><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
 <table class="tot" style="margin-top:8px"><tr><td></td><td class="r">Subtotal</td><td class="r" style="width:110px">${inr(o.subtotal)}</td></tr>
 ${o.coupon_discount ? `<tr><td></td><td class="r">Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ''}</td><td class="r">-${inr(o.coupon_discount)}</td></tr>` : ''}
 <tr><td></td><td class="r">Delivery</td><td class="r">${o.delivery_fee ? inr(o.delivery_fee) : 'FREE'}</td></tr>
 <tr class="grand"><td></td><td class="r">Total</td><td class="r">${inr(o.total)}</td></tr></table>
 <p class="muted" style="margin-top:24px;font-size:12px">Prices are inclusive of applicable taxes and packaging. Thank you for ordering with ${esc(b.name)}!</p>
 <p class="noprint"><button id="print-btn" type="button">Print / Save as PDF</button></p>
</div><script src="/admin/invoice.js"></script></body></html>`;
}

module.exports = { invoiceHtml };
