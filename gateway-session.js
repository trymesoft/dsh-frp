// Gateway session cookies and login throttling.
//
// The public entrance authenticates visitors itself, with its own cookie: the
// DSH signed cookie never leaves the gateway process (see gateway.js). The
// session payload carries the login epoch from credentials, so bumping that
// record invalidates every outstanding cookie without touching this class.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Compare two strings in constant time (length differences still short-circuit). */
export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    // Compare anyway on a padded copy so the early return is not the only work.
    const padded = Buffer.alloc(left.length);
    right.copy(padded);
    timingSafeEqual(left, padded);
    return false;
  }
  return timingSafeEqual(left, right);
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Issues and verifies gateway session cookies.
 *
 * @param {object} opts
 * @param {string} opts.signingSecret  random secret from credentials
 * @param {() => number} opts.epoch    live epoch getter (reads the credentials
 *                                     record on every call, so an epoch bump
 *                                     invalidates old cookies immediately)
 * @param {number} opts.ttlHours       cookie lifetime
 * @param {boolean} opts.secure        public entrance is https
 * @param {string} opts.cookieName     base cookie name (no __Host- prefix)
 */
export class SessionAuthority {
  constructor(opts) {
    this.signingSecret = opts.signingSecret;
    this.epoch = opts.epoch;
    this.ttlMs = Math.max(1, Number(opts.ttlHours) || 12) * 3600 * 1000;
    this.secure = Boolean(opts.secure);
    const base = String(opts.cookieName);
    this._name = this.secure && !base.startsWith('__Host-') ? '__Host-' + base : base;
  }

  /** The cookie name as sent to browsers (with the __Host- prefix when secure). */
  name() {
    return this._name;
  }

  /** Issue a signed session value for the current epoch. */
  issue(nowMs = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ exp: nowMs + this.ttlMs, epoch: this.epoch() }), 'utf8').toString('base64url');
    return payload + '.' + sign(this.signingSecret, payload);
  }

  /** True when the value is structurally sound, unexpired and from the live epoch. */
  verify(cookieValue, nowMs = Date.now()) {
    if (typeof cookieValue !== 'string' || cookieValue.length === 0) return false;
    const parts = cookieValue.split('.');
    if (parts.length !== 2) return false;
    const [payload, mac] = parts;
    if (payload.length === 0 || mac.length === 0) return false;
    if (!constantTimeEqual(mac, sign(this.signingSecret, payload))) return false;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (!parsed || typeof parsed.exp !== 'number' || typeof parsed.epoch !== 'number') return false;
    if (parsed.exp <= nowMs) return false;
    return parsed.epoch === this.epoch();
  }

  /** Set-Cookie value for a session, with every attribute the spec requires. */
  sessionCookieString(value) {
    const maxAge = Math.floor(this.ttlMs / 1000);
    const attributes = [
      this._name + '=' + value,
      'Path=/',
      'Max-Age=' + maxAge,
      'HttpOnly',
      'SameSite=Strict',
    ];
    if (this.secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  /** Set-Cookie value that removes the session cookie from a browser. */
  clearCookieString() {
    const attributes = [this._name + '=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
    if (this.secure) attributes.push('Secure');
    return attributes.join('; ');
  }
}

/**
 * A global failure delay for the login form.
 *
 * Rate limiting by client IP is useless in this topology — the gateway's TCP
 * peer is always 127.0.0.1 and X-Forwarded-For is attacker-controlled at the
 * first hop — so throttling is global instead: each failure multiplies the
 * enforced delay, capped at maxMs. Success never clears it; it decays slowly.
 */
export class LoginThrottle {
  constructor(opts = {}) {
    this.initialMs = opts.initialMs ?? 1000;
    this.maxMs = opts.maxMs ?? 30_000;
    this.decayIntervalMs = opts.decayIntervalMs ?? 300_000;
    this._delay = 0;
    this._lastDecay = null;
  }

  /** Record a failed attempt and return the delay that now applies. */
  noteFailure() {
    this._delay = this._delay === 0 ? this.initialMs : Math.min(this._delay * 2, this.maxMs);
    return this._delay;
  }

  /** The delay (ms) a login attempt must wait out before being answered. */
  currentDelay() {
    return this._delay;
  }

  /** Advance the clock: every decayIntervalMs halves the delay, flooring at initialMs. */
  tick(nowMs = Date.now()) {
    if (this._delay === 0) {
      this._lastDecay = nowMs;
      return;
    }
    if (this._lastDecay === null) {
      this._lastDecay = nowMs;
      return;
    }
    const elapsed = nowMs - this._lastDecay;
    if (elapsed < this.decayIntervalMs) return;
    const steps = Math.floor(elapsed / this.decayIntervalMs);
    for (let i = 0; i < steps; i += 1) {
      this._delay = Math.max(this.initialMs, Math.floor(this._delay / 2));
    }
    this._lastDecay = nowMs;
  }
}

/** A random secret for the session HMAC (stored in credentials, never in Config). */
export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}
