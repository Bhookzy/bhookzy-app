'use strict';
const { z } = require('zod');
const { cleanText } = require('./util');

const text = (min, max) => z.string().transform((s) => cleanText(s, max)).refine((s) => s.length >= min, { message: min ? `Must be at least ${min} characters` : 'Required' });
const optText = (max, multiline = false) => z.string().nullish().transform((s) => (s ? cleanText(s, max, { multiline }) : null));
const money = z.coerce.number().int().min(0).max(1_000_000);
const optMoney = z.union([z.literal(''), z.null(), money]).optional().transform((v) => (v === '' || v === undefined || v === null ? null : v));
const id = z.coerce.number().int().positive();
const bool = z.union([z.boolean(), z.literal('true'), z.literal('false')]).transform((v) => v === true || v === 'true');

// uploaded image (/media/..), bundled static file (/chaapdihatti.jpg) or an https link. Never javascript:/data:.
const imageUrl = z.string().nullish().transform((s) => (s ? s.trim() : null)).refine(
  (u) => !u || (u.length <= 600 && (/^\/media\/[A-Za-z0-9_-]+$/.test(u) || /^\/[A-Za-z0-9._\/-]+$/.test(u) || /^https:\/\/[^\s"'<>\\]+$/i.test(u))),
  { message: 'Use an uploaded image or an https:// image link' });

const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM');
const dateOnly = z.union([z.literal(''), z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')]).optional().transform((v) => v || null);

const waNumber = z.string().transform((s) => {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 10) d = `91${d}`;
  return d;
}).refine((d) => /^\d{11,15}$/.test(d), { message: 'Enter a valid WhatsApp number with country code, e.g. 919110062453' });

module.exports = { z, text, optText, money, optMoney, id, bool, imageUrl, timeStr, dateOnly, waNumber };
