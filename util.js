'use strict';
const crypto = require('crypto');
const config = require('../config');

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details;
  }
}
const badRequest = (msg, code = 'BAD_REQUEST', details) => new HttpError(400, msg, code, details);
const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');
const conflict = (msg, code = 'CONFLICT', details) => new HttpError(409, msg, code, details);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg, 'FORBIDDEN');

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate `data` with a zod schema; throws a 400 HttpError with per-field messages. */
function parse(schema, data) {
  const r = schema.safeParse(data === undefined ? {} : data);
  if (r.success) return r.data;
  const fields = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.entries(fields)[0];
  throw badRequest(first ? `${first[0] === '_' ? '' : first[0] + ': '}${first[1]}` : 'Invalid request', 'VALIDATION', fields);
}

/** Strip control characters, collapse whitespace runs, trim and cap the length. */
function cleanText(value, max = 200, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value).normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = s.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

/** BKZ-123456 */
const generateOrderCode = () => `BKZ-${crypto.randomInt(100000, 1000000)}`;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Calendar pieces of `date` as seen in the business time zone. */
function zonedParts(date = new Date(), tz = config.timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return {
    y: +p.year, m: +p.month, d: +p.day, hh: +hh, mm: +p.minute, ss: +p.second,
    dow: DOW.indexOf(p.weekday),
    dateStr: `${p.year}-${p.month}-${p.day}`,
    minutes: +hh * 60 + +p.minute,
  };
}

/** YYYY-MM-DD for today in the business time zone, shifted by `offsetDays`. */
function todayStr(offsetDays = 0, now = new Date()) {
  const { y, m, d } = zonedParts(now);
  const t = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return t.toISOString().slice(0, 10);
}

const timeToMinutes = (t) => { const [h, m] = String(t).split(':'); return (+h) * 60 + (+m || 0); };
function fmt12(t) {
  const mins = typeof t === 'number' ? t : timeToMinutes(t);
  const h = Math.floor(mins / 60) % 24; const m = mins % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "24 Nov 2026, 8:41 PM" in the business time zone. */
function formatDateTime(date, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(date)).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM');
}

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

module.exports = {
  HttpError, badRequest, notFound, conflict, forbidden, asyncH, parse, cleanText, slugify,
  randomToken, sha256, randomId, generateOrderCode, zonedParts, todayStr, timeToMinutes, fmt12,
  formatDateTime, inr, DOW,
};
