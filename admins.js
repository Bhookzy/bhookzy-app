'use strict';
const db = require('../db');
const { hashPassword, passwordProblem } = require('./security');
const { badRequest } = require('./util');

async function createAdmin({ email, password, name, role = 'owner', restaurantIds = [], createdBy = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid e-mail address.', 'VALIDATION');
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  const hash = await hashPassword(password);
  return db.tx(async (c) => {
    const u = (await c.query(
      `INSERT INTO users(kind, email, full_name, password_hash) VALUES ('admin', $1, $2, $3) RETURNING id`,
      [email, String(name || 'Admin').trim().slice(0, 80), hash])).rows[0];
    await c.query('INSERT INTO admin_users(user_id, role, created_by) VALUES ($1,$2,$3)', [u.id, role, createdBy]);
    if (role === 'manager') for (const rid of restaurantIds) await c.query('INSERT INTO admin_restaurants(admin_user_id, restaurant_id) VALUES ($1,$2)', [u.id, rid]);
    return u.id;
  });
}

module.exports = { createAdmin };
