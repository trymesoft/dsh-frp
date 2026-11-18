import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { createGateway, loginHtml } from '../gateway.js';
import { SessionAuthority, LoginThrottle } from '../gateway-session.js';

const DOMAIN = 'dsh.example.com';
const PUBLIC_BASE = 'https://' + DOMAIN;
const DSH_COOKIE = 'dsh-auth=INITIAL; Path=/';
const REFRESHED = 'dsh-auth=REFRESHED; Path=/';

async function startUpgradeStub(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-body:' + req.url);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, method: 'UPGRADE', headers: req.headers });
    respond(req, socket, server.address().port);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: server.address().port };
}

async function makeGateway(stubPort, overrides = {}) {
  const state = { harvested: [], authInvalid: 0, cookie: DSH_COOKIE };
  const authority = new SessionAuthority({
    signingSecret: 'secret',
    epoch: () => 1,
    ttlHours: 12,
    secure: false,
    cookieName: 'gw-session',
  });
  const gateway = createGateway({
    targetOrigin: () => 'http://127.0.0.1:' + stubPort,
    dshCookie: () => state.cookie,
    onDshCookie: (cookie) => state.harvested.push(cookie),
    onAuthInvalid: async () => {
      state.authInvalid += 1;
      state.cookie = REFRESHED;
    },
    authority,
    checkLogin: async (u, p) => u === 'owner' && p === 'correct horse battery',
    throttle: new LoginThrottle({ initialMs: 0, maxMs: 0 }),
    publicDomain: () => DOMAIN,
    publicBaseUrl: () => PUBLIC_BASE,
    loginHtml,
    ...overrides,
  });
  const { port } = await gateway.listen();
  return { gateway, port, state, authority };
}

function httpRequest(port, { method = 'GET', path: pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { Host: DOMAIN, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function login(port) {
  const form = 'username=owner&password=' + encodeURIComponent('correct horse battery');
  const res = await httpRequest(port, {
    method: 'POST',
    path: '/frp-login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
    body: form,
  });
  return String(res.headers['set-cookie']).split(';')[0];
}

function rawUpgrade(port, cookie) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\nHost: ' + DOMAIN + '\r\nCookie: ' + cookie +
          '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    const done = () => {
      socket.destroy();
      resolve(data);
    };
    socket.on('close', done);
    socket.on('error', done);
    setTimeout(() => {
      if (data.includes('101')) socket.write('ping');
      else done();
    }, 250).unref();
    setTimeout(done, 1500).unref();
  });
}

test('a non-101 upgrade answer is filtered like any other response', async () => {
  const stub = await startUpgradeStub((req, socket, port) => {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nSet-Cookie: dsh-auth-abc=LEAK; Path=/\r\nLocation: http://127.0.0.1:' + port +
        '/nope\r\nContent-Type: text/plain\r\nContent-Length: 7\r\n\r\nforbid',
    );
    socket.end();
  });
  const { gateway, port, state } = await makeGateway(stub.port);
  try {
    const cookie = await login(port);
    const raw = await rawUpgrade(port, cookie);
    assert.match(raw, /403 Forbidden/);
    assert.doesNotMatch(raw, /Set-Cookie/i, 'no cookie may reach the browser on the upgrade path');
    assert.doesNotMatch(raw, /127\.0\.0\.1:\d+/, 'the loopback origin must not leak');
    assert.ok(raw.includes(PUBLIC_BASE + '/nope'), 'Location is rewritten to the public base');
    assert.deepEqual(state.harvested, ['dsh-auth-abc=LEAK; Path=/']);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('a 401 upgrade answer refreshes the DSH cookie once and then relays', async () => {
  let attempts = 0;
  const stub = await startUpgradeStub((req, socket) => {
    attempts += 1;
    if (req.headers.cookie === REFRESHED) {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (chunk) => socket.write('echo:' + chunk.toString()));
      return;
    }
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.end();
  });
  const { gateway, port, state } = await makeGateway(stub.port);
  try {
    const cookie = await login(port);
    const raw = await rawUpgrade(port, cookie);
    assert.equal(state.authInvalid, 1, 'the gateway re-exchanged exactly once');
    assert.match(raw, /101 Switching Protocols/);
    assert.match(raw, /echo:ping/);
    assert.equal(attempts, 2);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});
