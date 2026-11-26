'use strict';
// Central configuration. Every secret comes from environment variables — nothing is hardcoded.
require('dotenv').config();

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL || '',
  // 'require' = encrypted connection (works with Supabase/Neon/Render), 'verify' = also verify the certificate,
  // 'disable' = plain TCP (local development only). 'auto' = require when the host is not localhost.
  databaseSsl: (env.DATABASE_SSL || 'auto').toLowerCase(),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === undefined ? (isProd ? 1 : false) : (/^\d+$/.test(env.TRUST_PROXY) ? int(env.TRUST_PROXY, 1) : bool(env.TRUST_PROXY)),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),          // idle timeout
  sessionMaxDays: int(env.SESSION_MAX_DAYS, 7),             // absolute lifetime
  timezone: env.APP_TIMEZONE || 'Asia/Kolkata',
  autoMigrate: bool(env.AUTO_MIGRATE, true),
  autoSeed: bool(env.AUTO_SEED, true),                         // load the starter menu once, into an empty database
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  bootstrapAdmin: {
    email: env.BOOTSTRAP_ADMIN_EMAIL || '',
    password: env.BOOTSTRAP_ADMIN_PASSWORD || '',
    name: env.BOOTSTRAP_ADMIN_NAME || 'Owner',
  },
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 4) * 1024 * 1024,
  rateLimitScale: Math.max(1, int(env.RATE_LIMIT_SCALE, 1)),   // tests raise this; leave at 1 in production
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
};

if (!/^[A-Za-z0-9_\/+-]+$/.test(config.timezone)) throw new Error('APP_TIMEZONE is not a valid IANA time zone name');

module.exports = config;
