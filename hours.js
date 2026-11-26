'use strict';
const { zonedParts, timeToMinutes, fmt12, DOW } = require('./util');

/**
 * hoursByDow: { 0..6: {opens_at, closes_at, is_closed} } (TIME strings 'HH:MM[:SS]').
 * Returns { open, text } — text is a customer-friendly sentence.
 */
function openStatus(hoursByDow, now = new Date()) {
  const { dow, minutes } = zonedParts(now);
  const today = hoursByDow[dow];
  const yesterday = hoursByDow[(dow + 6) % 7];

  const windowOpen = (h, mins) => {
    if (!h || h.is_closed) return null;
    const o = timeToMinutes(h.opens_at); const c = timeToMinutes(h.closes_at);
    if (c > o) return mins >= o && mins < c ? { until: c } : null;
    return mins >= o ? { until: c } : null; // overnight window, evening part
  };
  const a = windowOpen(today, minutes);
  if (a) return { open: true, text: `Open until ${fmt12(a.until)}`, closes_at: fmt12(a.until) };
  // overnight window that started yesterday and has not ended yet
  if (yesterday && !yesterday.is_closed) {
    const o = timeToMinutes(yesterday.opens_at); const c = timeToMinutes(yesterday.closes_at);
    if (c <= o && minutes < c) return { open: true, text: `Open until ${fmt12(c)}`, closes_at: fmt12(c) };
  }
  // closed: find the next opening
  for (let i = 0; i < 7; i++) {
    const d = (dow + i) % 7; const h = hoursByDow[d];
    if (!h || h.is_closed) continue;
    const o = timeToMinutes(h.opens_at);
    if (i === 0 && minutes >= o) continue;
    const when = i === 0 ? 'today' : i === 1 ? 'tomorrow' : DOW[d];
    return { open: false, text: `Closed • Opens ${when} at ${fmt12(o)}`, opens_text: `${when} ${fmt12(o)}` };
  }
  return { open: false, text: 'Closed' };
}

/** Build the per-day map from restaurant_hours rows; falls back to the store-wide hours. */
function hoursMap(rows, storeHours) {
  const map = {};
  if (rows && rows.length) {
    for (const r of rows) map[r.day_of_week] = r;
  } else {
    const days = storeHours.days || [0, 1, 2, 3, 4, 5, 6];
    for (let d = 0; d < 7; d++) {
      map[d] = { day_of_week: d, opens_at: storeHours.open, closes_at: storeHours.close, is_closed: !days.includes(d) };
    }
  }
  for (let d = 0; d < 7; d++) {
    if (!map[d]) map[d] = { day_of_week: d, opens_at: '17:00', closes_at: '22:30', is_closed: true };
  }
  return map;
}

/** Is a product inside its optional daily availability window (IST)? */
function inDailyWindow(from, to, now = new Date()) {
  if (!from || !to) return true;
  const { minutes } = zonedParts(now);
  const f = timeToMinutes(from); const t = timeToMinutes(to);
  return t > f ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

module.exports = { openStatus, hoursMap, inDailyWindow };
