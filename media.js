'use strict';
const sharp = require('sharp');
const db = require('../db');
const { badRequest, randomId } = require('./util');

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'gif';
  return null;   // SVG and everything else is refused (SVG can carry scripts)
}

/** Validates the real file type (not the client-supplied one), resizes to web sizes and stores it in the database. */
async function saveImage(buffer, userId) {
  if (!sniff(buffer)) throw badRequest('Please upload a JPG, PNG, WebP or GIF image.', 'BAD_IMAGE');
  let main; let thumb;
  try {
    const base = sharp(buffer, { limitInputPixels: 50_000_000 }).rotate();
    main = await base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    thumb = await base.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  } catch (_) {
    throw badRequest('That image could not be read. Try a different file.', 'BAD_IMAGE');
  }
  const id = randomId(9);
  await db.query(
    `INSERT INTO media(id, mime, data, thumb, width, height, bytes, created_by) VALUES ($1,'image/webp',$2,$3,$4,$5,$6,$7)`,
    [id, main.data, thumb, main.info.width, main.info.height, main.data.length, userId || null]);
  return { id, url: `/media/${id}`, width: main.info.width, height: main.info.height, bytes: main.data.length };
}

module.exports = { saveImage, sniff };
