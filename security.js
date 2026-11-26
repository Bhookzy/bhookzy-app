'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-recommended minimum: N=2^17 for interactive; 2^15 keeps login snappy on small servers)
const N = 32768, R = 8, P = 1, KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scrypt(password, salt, expected.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
    return crypto.timingSafeEqual(dk, expected);
  } catch (_) {
    return false;
  }
}

// A real hash used to burn the same CPU time when the e-mail does not exist (prevents user enumeration by timing).
let dummyHash;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password-' + crypto.randomBytes(8).toString('hex'));
  await verifyPassword(password, dummyHash);
}

/** Password rules: >= 10 chars, not trivially weak. */
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and at least one number.';
  const weak = ['password123', '1234567890', 'qwerty12345', 'bhookzy123', 'admin12345'];
  if (weak.includes(pw.toLowerCase())) return 'That password is too easy to guess.';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem };
