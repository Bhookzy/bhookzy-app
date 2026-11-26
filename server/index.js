'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const { getSettings } = require('./lib/settings');
const { notFoundApi, errorHandler } = require('./middleware/errors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BUILD_ID = crypto.createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8);

const PUBLIC_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],            // the storefront markup uses inline onclick handlers (all data is escaped)
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'object-src': ["'none'"],
};
const ADMIN_CSP = { ...PUBLIC_CSP, 'script-src': ["'self'"] };       // admin dashboard: no inline scripts at all

function baseUrl(req) {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => { req.id = crypto.randomBytes(5).toString('hex'); next(); });
  app.use(compression());
  app.use((req, res, next) => {
    const isAdmin = req.path === '/admin' || req.path.startsWith('/admin/') || req.path.startsWith('/api/admin');
    return helmet({
      contentSecurityPolicy: { useDefaults: false, directives: isAdmin ? ADMIN_CSP : PUBLIC_CSP },
      hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })(req, res, next);
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  if (config.logLevel === 'debug' || config.logLevel === 'info') {
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) {
        const t = Date.now();
        res.on('finish', () => { if (config.env !== 'test') console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms`); });
      }
      next();
    });
  }

  // ---- API
  const publicRoutes = require('./routes/public');
  app.use('/api/admin', require('./admin'));
  app.use('/api', publicRoutes);
  app.use('/api', notFoundApi);
  app.use('/media', require('./routes/media'));
  app.locals.invalidateMenuCache = publicRoutes.invalidateMenuCache;

  // ---- static files
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseUrl(req)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url></urlset>`);
  });
  app.use((req, res, next) => {
    if (req.method === 'GET' && /\.(js|css|woff2?|png|jpe?g|svg|webp|ico)$/i.test(req.path)) {
      res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=600');
    }
    next();
  });

  // admin single-page app
  const adminHtml = () => fs.readFileSync(path.join(PUBLIC_DIR, 'admin', 'index.html'), 'utf8').replace(/\{\{V\}\}/g, BUILD_ID);
  const sendAdmin = (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).type('html').send(adminHtml());
  };
  app.get(['/admin', '/admin/'], sendAdmin);
  app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin'), { index: false }));
  app.get(/^\/admin\/.*/, sendAdmin);

  // storefront
  let tpl = null; let tplMtime = 0;
  const pageCache = new Map();
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  app.get(['/', '/index.html'], async (req, res, next) => {
    try {
      const file = path.join(PUBLIC_DIR, 'index.html');
      const mtime = fs.statSync(file).mtimeMs;
      if (!tpl || mtime !== tplMtime) { tpl = fs.readFileSync(file, 'utf8'); tplMtime = mtime; pageCache.clear(); }
      const base = baseUrl(req);
      const hit = pageCache.get(base);
      if (hit && Date.now() - hit.at < 60_000) return res.set('Cache-Control', 'no-cache').type('html').send(hit.html);
      const s = await getSettings();
      const jsonLd = {
        '@context': 'https://schema.org', '@type': 'Restaurant', name: s.business.name, url: base, telephone: `+91${s.business.phone}`,
        servesCuisine: ['Indian', 'Vegetarian', 'Chaap', 'Momos'], priceRange: '₹',
        address: { '@type': 'PostalAddress', addressLocality: 'Ranchi', addressRegion: 'Jharkhand', addressCountry: 'IN', streetAddress: s.business.address },
        openingHours: `${s.hours.open}-${s.hours.close}`.replace(/^/, 'Mo-Su '),
        image: s.branding.hero_image, description: 'Order 100% pure vegetarian food online in Ranchi — tandoori chaap, momos, burgers, rolls & biryani.',
        potentialAction: { '@type': 'OrderAction', target: base + '/' },
      };
      const html = tpl
        .replace(/\{\{V\}\}/g, BUILD_ID)
        .replace(/\{\{CANONICAL\}\}/g, base + '/')
        .replace(/\{\{OG_IMAGE\}\}/g, esc(/^https:\/\//.test(s.branding.hero_image || '') ? s.branding.hero_image : base + (s.branding.logo_url || '/logo.jpg')))
        .replace('{{JSON_LD}}', JSON.stringify(jsonLd).replace(/</g, '\\u003c'));
      pageCache.set(base, { at: Date.now(), html });
      res.set('Cache-Control', 'no-cache').type('html').send(html);
    } catch (e) { next(e); }
  });
  app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore' }));

  app.use(errorHandler);
  return app;
}

async function start() {
  if (config.autoMigrate) await require('./scripts/migrate').migrate();
  await seedIfEmpty();
  await bootstrapAdminIfNeeded();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`Bhookzy running on http://localhost:${config.port}  (admin: /admin)`));
  const shutdown = async (sig) => {
    console.log(`${sig} received — shutting down`);
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

/** First boot on an empty database: load the starter menu once. Never runs again (so dishes you delete stay deleted). */
async function seedIfEmpty() {
  if (!config.autoSeed) return;
  const { rows } = await db.query(`SELECT (SELECT count(*)::int FROM restaurants) AS n, EXISTS (SELECT 1 FROM store_settings WHERE key = 'seeded') AS done`);
  if (rows[0].n > 0 || rows[0].done) return;
  console.log('[seed] Empty database — loading the Bhookzy starter menu (270 dishes, 3 kitchens)…');
  await require('./scripts/seed').seedAll();
  await db.query(`INSERT INTO store_settings(key, value) VALUES ('seeded', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`);
}

/** One-time owner creation for hosts with no shell access (set both env vars, deploy once, then DELETE them). */
async function bootstrapAdminIfNeeded() {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) return;
  const { rows } = await db.query('SELECT count(*)::int AS n FROM admin_users');
  if (rows[0].n > 0) {
    console.warn('[bootstrap] An admin already exists — BOOTSTRAP_ADMIN_* variables are ignored. Remove them from your environment.');
    return;
  }
  const { createAdmin } = require('./lib/admins');
  await createAdmin({ email, password, name, role: 'owner' });
  console.log(`[bootstrap] Owner account created for ${email}. Remove BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD from your environment now.`);
}

module.exports = { createApp, start };

if (require.main === module) {
  start().catch((e) => { console.error('Failed to start:', e.message); process.exit(1); });
}
