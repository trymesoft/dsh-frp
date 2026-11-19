import test from 'node:test';
import assert from 'node:assert/strict';

import { constantTimeEqual, SessionAuthority, LoginThrottle } from '../src/gateway-session.js';

const SECRET = 'signing-secret-for-tests';
const HOUR = 3600 * 1000;

function makeAuthority(overrides = {}) {
  let epoch = overrides.epoch ?? 1;
  const authority = new SessionAuthority({
    signingSecret: SECRET,
    epoch: () => epoch,
    ttlHours: 12,
    secure: false,
    cookieName: 'gw-session',
  });
  return {
    authority,
    bumpEpoch: () => {
      epoch += 1;
    },
    getEpoch: () => epoch,
  };
}

test('constantTimeEqual compares without early exit', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('a freshly issued cookie verifies inside its lifetime and epoch', () => {
  const { authority } = makeAuthority();
  const now = 1_700_000_000_000;
  const cookie = authority.issue(now);
  assert.equal(authority.verify(cookie, now + 1000), true);
  assert.equal(authority.verify(cookie, now + 11 * HOUR), true);
});

test('a live epoch bump invalidates the same instance old cookie', () => {
  const { authority, bumpEpoch } = makeAuthority();
  const now = 1_700_000_000_000;
  const cookie = authority.issue(now);
  assert.equal(authority.verify(cookie, now + 1000), true);
  bumpEpoch();
  assert.equal(authority.verify(cookie, now + 1000), false, 'epoch getter bump must kill the old cookie');
});

test('expired cookies and tampered payloads are rejected', () => {
  const { authority } = makeAuthority();
  const now = 1_700_000_000_000;
  const cookie = authority.issue(now);
  assert.equal(authority.verify(cookie, now + 13 * HOUR), false);

  const [payload, mac] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: now + 99 * HOUR, epoch: 1 }), 'utf8').toString('base64url');
  assert.equal(authority.verify(forged + '.' + mac, now), false);
  assert.equal(authority.verify(payload + '.' + mac.replace(/.$/, mac.endsWith('A') ? 'B' : 'A'), now), false);
  assert.equal(authority.verify('', now), false);
  assert.equal(authority.verify('garbage', now), false);
});

test('a cookie signed with another secret is rejected', () => {
  const { authority } = makeAuthority();
  const foreign = new SessionAuthority({
    signingSecret: 'foreign signing secret',
    epoch: () => 1,
    ttlHours: 12,
    secure: false,
    cookieName: 'gw-session',
  });
  const now = 1_700_000_000_000;
  assert.equal(authority.verify(foreign.issue(now), now), false);
});

test('session cookie string carries HttpOnly, SameSite=Strict, Path=/ and no Domain', () => {
  const { authority } = makeAuthority();
  const now = 1_700_000_000_000;
  const header = authority.sessionCookieString(authority.issue(now));
  assert.match(header, /^gw-session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, /Domain=/i);
  assert.doesNotMatch(header, /Secure/);
  assert.equal(authority.name(), 'gw-session');
});

test('secure mode uses the __Host- prefix and adds Secure', () => {
  const authority = new SessionAuthority({
    signingSecret: SECRET,
    epoch: () => 1,
    ttlHours: 12,
    secure: true,
    cookieName: 'gw-session',
  });
  const now = 1_700_000_000_000;
  const header = authority.sessionCookieString(authority.issue(now));
  assert.match(header, /^__Host-gw-session=/);
  assert.match(header, /Secure/);
  assert.equal(authority.name(), '__Host-gw-session');
});

test('LoginThrottle ramps 1s → 2s → 4s … capped at 30s', () => {
  const throttle = new LoginThrottle();
  assert.equal(throttle.currentDelay(), 0);
  const seen = [];
  for (let i = 0; i < 7; i += 1) {
    throttle.noteFailure();
    seen.push(throttle.currentDelay());
  }
  assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('LoginThrottle decays slowly and never resets on success', () => {
  const throttle = new LoginThrottle({ decayIntervalMs: 60_000 });
  const start = 1_700_000_000_000;
  throttle.tick(start);
  for (let i = 0; i < 5; i += 1) throttle.noteFailure();
  const peak = throttle.currentDelay();
  assert.equal(peak, 16000);

  // Success does not clear the penalty.
  throttle.tick(start + 1000);
  assert.equal(throttle.currentDelay(), peak);

  throttle.tick(start + 61_000);
  assert.ok(throttle.currentDelay() < peak, 'one decay interval must lower the delay');
  const afterOne = throttle.currentDelay();
  assert.equal(afterOne, 8000);

  throttle.tick(start + 10 * 60_000);
  assert.ok(throttle.currentDelay() < afterOne);
  throttle.tick(start + 60 * 60_000);
  assert.ok(throttle.currentDelay() <= 1000, 'decay floors at the initial delay, never zero');
});
