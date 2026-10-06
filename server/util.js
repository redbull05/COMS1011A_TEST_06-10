'use strict';

const crypto = require('crypto');

/** Turn an arbitrary name into a short, filesystem-safe slug. */
function slugify(input, max = 40) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return s || 'repo';
}

/** Short random suffix for unique repository ids. */
function shortId(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Round a number to `dp` decimal places (keeps JSON tidy). */
function round(n, dp = 6) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

module.exports = { slugify, shortId, round };
