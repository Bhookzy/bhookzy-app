'use strict';
const db = require('../db');

// Defaults reproduce the behaviour/branding of the original Bhookzy site.
const DEFAULTS = {
  business: {
    name: 'Bhookzy',
    tagline: 'Har Bite Mein Swaad, Har Order Mein Bharosa.',
    phone: '9110062453',
    email: 'support@bhookzy.com',
    address: 'Kanke Road & Morabadi, Ranchi, Jharkhand',
    service_area_text: 'Kanke Road, Morabadi, Ranchi',
  },
  whatsapp: { order_number: '919110062453', support_number: '919110062453' },
  branding: {
    logo_url: '/logo.jpg',
    hero_title: '100% Pure Veg Food Delivery in Ranchi',
    hero_bullets: ['Hot & Fresh Food', 'Trusted Pure-Veg Kitchens', 'FREE Delivery above ₹149 (3 KM)'],
    hero_image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=450&q=80',
    banner_enabled: false,
    banner_text: '',
  },
  social: { instagram: '', facebook: '', youtube: '', x: '' },
  footer: { text: 'Har Bite Mein Swaad, Har Order Mein Bharosa • Kanke Road & Morabadi, Ranchi' },
  hours: { open: '17:00', close: '22:30', days: [0, 1, 2, 3, 4, 5, 6] },
  service: {
    accepting_orders: true,
    temporarily_closed: false,
    closed_message: 'We are temporarily closed. Please check back soon!',
    enforce_hours: true,
    default_delivery_charge: 20,
    default_free_delivery_threshold: 149,
    min_order_value: 0,
    delivery_info: 'Express delivery within 3 KM of Kanke Road & Morabadi. FREE delivery on orders ₹149+, ₹20 below ₹149.',
  },
  payment: { cod_enabled: true, upi_whatsapp_enabled: true, upi_id: '' },
};

const PUBLIC_KEYS = {
  business: ['name', 'tagline', 'phone', 'email', 'address', 'service_area_text'],
  whatsapp: ['order_number', 'support_number'],
  branding: null, social: null, footer: null, hours: null,
  service: ['accepting_orders', 'temporarily_closed', 'closed_message', 'default_delivery_charge', 'default_free_delivery_threshold', 'min_order_value', 'delivery_info'],
  payment: ['cod_enabled', 'upi_whatsapp_enabled'],   // upi_id is NOT public: the owner shares it manually on WhatsApp
};

let cache = null; let cachedAt = 0;
const TTL_MS = 3000;

async function loadAll() {
  const { rows } = await db.query('SELECT key, value FROM store_settings');
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = { ...DEFAULTS[k] };
  let menuVersion = 1;
  for (const r of rows) {
    if (r.key === 'menu_version') { menuVersion = Number(r.value) || 1; continue; }
    if (out[r.key] && typeof r.value === 'object' && !Array.isArray(r.value)) out[r.key] = { ...DEFAULTS[r.key], ...r.value };
  }
  out.menu_version = menuVersion;
  return out;
}

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = await loadAll(); cachedAt = Date.now();
  return cache;
}

function publicSettings(all) {
  const out = {};
  for (const [group, keys] of Object.entries(PUBLIC_KEYS)) {
    out[group] = keys ? Object.fromEntries(keys.map((k) => [k, all[group][k]])) : all[group];
  }
  return out;
}

async function saveGroup(group, value, userId, client = db) {
  if (!DEFAULTS[group]) throw new Error(`Unknown settings group ${group}`);
  await client.query(
    `INSERT INTO store_settings(key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [group, JSON.stringify(value), userId || null]);
  invalidate();
}

/** Bump the version customers poll to know the catalogue changed. */
async function bumpMenuVersion(client = db) {
  await client.query(
    `INSERT INTO store_settings(key, value) VALUES ('menu_version', '1'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb((store_settings.value #>> '{}')::int + 1), updated_at = now()`);
  invalidate();
}

function invalidate() { cache = null; }

module.exports = { DEFAULTS, getSettings, publicSettings, saveGroup, bumpMenuVersion, invalidate };
