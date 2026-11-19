import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { createGateway, loginHtml, negotiateLocale } from '../src/gateway.js';
import { SessionAuthority, LoginThrottle } from '../src/gateway-session.js';

const RETRY_COOKIE = 'dsh-auth-abc=RETRY; Path=/';
const DOMAIN = 'dsh.example.com';
const PUBLIC_BASE = 'https://' + DOMAIN;
const USER = 'owner';
const PASSWORD = 'correct horse battery';
const DSH_COOKIE = 'dsh-auth-abc=INITIAL; Path=/';

function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/setcookie') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'dsh-auth-abc=ROTATED; Path=/; HttpOnly' });
      res.end('rotated');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:' + server.address().port + '/x' });
      res.end();
      return;
    }
    if (req.url === '/unauth') {
      if (req.headers.cookie === RETRY_COOKIE) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('upstream-body:/unauth');
      } else {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
      }
      return;
    }
    if (req.url === '/boom') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-body:' + req.url);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, method: 'UPGRADE', headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write('echo:' + chunk.toString()));
    socket.on('error', () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function makeGateway(stub, overrides = {}) {
  const state = {
    dshCookie: overrides.dshCookie ?? DSH_COOKIE,
    harvested: [],
    authInvalidCalls: 0,
    exchanges: 0,
  };
  const authority = new SessionAuthority({
    signingSecret: 'kernel-secret-for-tests',
    epoch: () => 1,
    ttlHours: 12,
    secure: false,
    cookieName: 'gw-session',
  });
  const gateway = createGateway({
    targetOrigin: () => 'http://127.0.0.1:' + stub.port,
    dshCookie: () => state.dshCookie,
    onDshCookie: (cookie) => {
      state.harvested.push(cookie);
      const pair = cookie.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const rest = state.dshCookie.split('; ').filter((part) => !part.startsWith(name + '=')).join('; ');
      state.dshCookie = rest ? rest + '; ' + pair : pair;
    },
    onAuthInvalid: async () => {
      state.authInvalidCalls += 1;
      state.exchanges += 1;
      state.dshCookie = RETRY_COOKIE;
    },
    authority,
    checkLogin: async (username, password) => username === USER && password === PASSWORD,
    throttle: overrides.throttle ?? new LoginThrottle(),
    publicDomain: () => DOMAIN,
    publicBaseUrl: () => PUBLIC_BASE,
    loginHtml,
    ...overrides.gateway,
  });
  const { port } = await gateway.listen();
  return { gateway, port, state, authority };
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: DOMAIN, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sessionCookieOf(response) {
  const raw = response.headers['set-cookie'];
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  return list[0].split(';')[0];
}

async function login(port, password = PASSWORD) {
  const body = 'username=' + encodeURIComponent(USER) + '&password=' + encodeURIComponent(password);
  return request(port, {
    method: 'POST',
    path: '/frp-login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    body,
  });
}

function rawExchange(port, payload) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 1500).unref();
  });
}

test('unauthenticated requests see the login page and nothing else', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const page = await request(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.body, /<form[^>]+action="\/frp-login"/i);
    assert.match(page.body, /type="password"/i);
    assert.match(page.body, /lang="en"/, 'no Accept-Language means English');
    assert.match(page.body, /Sign in to continue/);
    assert.ok(page.body.includes(DOMAIN), 'the login page names the tunnel host');

    const chinese = await request(port, { path: '/', headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
    assert.match(chinese.body, /lang="zh-CN"/);
    assert.match(chinese.body, /登录以继续/);

    const withError = await request(port, { path: '/?e=1', headers: { 'accept-language': 'en-US,en;q=0.9' } });
    assert.equal(withError.status, 200);
    assert.match(withError.body, /data-login-error/);
    assert.match(withError.body, /Incorrect username or password/);

    const zhError = await request(port, { path: '/?e=1', headers: { 'accept-language': 'zh-CN' } });
    assert.match(zhError.body, /用户名或密码不正确/);

    for (const path of ['/api/anything', '/index.html', '/static/app.js']) {
      const res = await request(port, { path });
      assert.equal(res.status, 302, path + ' must redirect to the login page');
      assert.equal(res.headers.location, '/');
      assert.doesNotMatch(res.body, /upstream-body/);
    }
    assert.equal(stub.seen.length, 0, 'the upstream must not be reached without a session');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('concurrent login attempts are serialized so one failure delay applies to each', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub, {
    gateway: { throttle: new LoginThrottle({ initialMs: 300, maxMs: 300, decayIntervalMs: 60_000 }) },
  });
  try {
    const started = Date.now();
    await Promise.all([login(port, 'wrong one'), login(port, 'wrong two')]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250, 'the second attempt must wait for the delay the first failure set, took ' + elapsed + 'ms');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('login: wrong password is redirected back with a fixed error param, right password issues one cookie', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub, { throttle: new LoginThrottle({ initialMs: 1, maxMs: 1 }) });
  try {
    const bad = await login(port, 'wrong password');
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.location, '/?e=1');
    assert.equal(bad.headers['set-cookie'], undefined);

    const good = await login(port);
    assert.equal(good.status, 302);
    assert.equal(good.headers.location, '/');
    const cookie = sessionCookieOf(good);
    assert.ok(cookie && cookie.startsWith('gw-session='), 'a gateway session cookie is set');
    assert.match((good.headers['set-cookie'] && good.headers['set-cookie'][0]) ?? '', /HttpOnly/);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('login is delayed by the throttle before the answer is given', async () => {
  const stub = await startStub();
  const throttle = new LoginThrottle({ initialMs: 120, maxMs: 120 });
  throttle.noteFailure();
  throttle.noteFailure();
  const { gateway, port } = await makeGateway(stub, { throttle });
  try {
    const started = Date.now();
    await login(port, 'wrong password');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, 'login must wait out the throttle delay, took ' + elapsed + 'ms');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('authenticated proxying normalizes the fence headers and injects the DSH cookie', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const cookie = sessionCookieOf(await login(port));
    const res = await request(port, {
      path: '/api/anything?x=1',
      headers: {
        Cookie: cookie,
        Origin: PUBLIC_BASE,
        'sec-fetch-site': 'cross-site',
        'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        'x-real-ip': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'user-agent': 'probe-agent',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'upstream-body:/api/anything?x=1');

    const seen = stub.seen.at(-1);
    assert.equal(seen.headers.host, '127.0.0.1:' + stub.port);
    assert.equal(seen.headers.origin, undefined);
    assert.equal(seen.headers['sec-fetch-site'], undefined);
    assert.equal(seen.headers['x-real-ip'], undefined);
    assert.equal(seen.headers['x-forwarded-proto'], undefined);
    assert.equal(seen.headers['x-forwarded-for'], '203.0.113.9');
    assert.equal(seen.headers.cookie, DSH_COOKIE, 'the visitor cookie is replaced wholesale by the DSH cookie');
    assert.equal(seen.headers['user-agent'], 'probe-agent');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('red line: upstream Set-Cookie is harvested and never reaches the browser', async () => {
  const stub = await startStub();
  const { gateway, port, state } = await makeGateway(stub);
  try {
    const cookie = sessionCookieOf(await login(port));
    const res = await request(port, { path: '/setcookie', headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['set-cookie'], undefined, 'no Set-Cookie may reach the browser');
    assert.equal(res.headers['set-cookie2'], undefined);
    assert.deepEqual(state.harvested, ['dsh-auth-abc=ROTATED; Path=/; HttpOnly']);
    assert.match(state.dshCookie, /ROTATED/);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('upstream Location is rewritten to the public base URL', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const cookie = sessionCookieOf(await login(port));
    const res = await request(port, { path: '/redirect', headers: { Cookie: cookie } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, PUBLIC_BASE + '/x');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('an upstream 401 triggers exactly one re-exchange and the retry succeeds', async () => {
  const stub = await startStub();
  let refreshed = false;
  const { gateway, port, state } = await makeGateway(stub, {
    gateway: {
      onAuthInvalid: async () => {
        state.authInvalidCalls += 1;
        refreshed = true;
        state.dshCookie = RETRY_COOKIE;
      },
      dshCookie: () => (refreshed ? RETRY_COOKIE : DSH_COOKIE),
    },
  });
  try {
    const cookie = sessionCookieOf(await login(port));
    const res = await request(port, { path: '/unauth', headers: { Cookie: cookie } });
    assert.equal(state.authInvalidCalls, 1);
    assert.equal(res.status, 200, 'the retried request uses the refreshed cookie');
    assert.equal(res.body, 'upstream-body:/unauth');
    assert.equal(stub.seen.at(-1).headers.cookie, RETRY_COOKIE);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('a foreign Host header gets 404 and never reaches the upstream', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const res = await request(port, { path: '/', headers: { Host: 'evil.example.com' } });
    assert.equal(res.status, 404);
    assert.equal(stub.seen.length, 0);
    const leftover = await request(port, { path: '/api/x', headers: { Host: 'localhost' } });
    assert.equal(leftover.status, 404);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('a malformed framing request (TE + CL) is answered with 400, not a hang', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const raw = await rawExchange(
      port,
      'POST /api/smuggle HTTP/1.1\r\nHost: ' + DOMAIN + '\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
    );
    assert.match(raw, /HTTP\/1\.1 400/);
    assert.equal(stub.seen.length, 0);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('a WebSocket upgrade without a session is refused with 401, not a redirect', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const raw = await rawExchange(
      port,
      'GET /api/remote.mux HTTP/1.1\r\nHost: ' + DOMAIN + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    assert.match(raw, /HTTP\/1\.1 401/);
    assert.equal(stub.seen.length, 0);
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('an authenticated WebSocket upgrade is relayed end to end with the DSH cookie injected', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const cookie = sessionCookieOf(await login(port));
    const received = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\nHost: ' + DOMAIN + '\r\nCookie: ' + cookie +
            '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('101 Switching Protocols') && !data.includes('echo:ping')) socket.write('ping');
        if (data.includes('echo:ping')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', () => resolve(data));
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 2000).unref();
    });
    assert.match(received, /101 Switching Protocols/);
    assert.match(received, /echo:ping/);

    const seen = stub.seen.at(-1);
    assert.equal(seen.method, 'UPGRADE');
    assert.equal(seen.url, '/api/remote.mux');
    assert.equal(seen.headers.cookie, DSH_COOKIE);
    assert.equal(seen.headers.host, '127.0.0.1:' + stub.port);
    assert.equal(seen.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
    assert.equal(seen.headers.upgrade, 'websocket');
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('an unreachable upstream yields 502 and the gateway session survives', async () => {
  const stub = await startStub();
  const { gateway, port } = await makeGateway(stub);
  try {
    const cookie = sessionCookieOf(await login(port));
    const dead = http.createServer();
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));

    const res = await request(port, { path: '/api/x', headers: { Cookie: cookie } });
    assert.equal(res.status, 200, 'sanity: the live upstream still works');

    const { gateway: deadGateway, port: deadGwPort } = await makeGateway(stub, {
      gateway: { targetOrigin: () => 'http://127.0.0.1:' + deadPort },
    });
    try {
      const fail = await request(deadGwPort, { path: '/api/x' });
      assert.equal(fail.status, 302, 'no session still redirects');

      const deadLoginPort = deadGwPort;
      const loginRes = await login(deadLoginPort);
      const deadCookie = sessionCookieOf(loginRes);
      const failAuthed = await request(deadLoginPort, { path: '/api/x', headers: { Cookie: deadCookie } });
      assert.equal(failAuthed.status, 502);
      assert.match(failAuthed.body, /502/);

      const again = await request(deadLoginPort, { path: '/api/x', headers: { Cookie: deadCookie } });
      assert.equal(again.status, 502, 'the gateway session is preserved after a 502');
    } finally {
      await deadGateway.stop();
    }
  } finally {
    await gateway.stop();
    stub.server.close();
  }
});

test('negotiateLocale picks the ranked supported language', () => {
  assert.equal(negotiateLocale('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(negotiateLocale('en-US,en;q=0.9'), 'en');
  assert.equal(negotiateLocale('fr-FR,fr;q=0.9,zh;q=0.8'), 'zh');
  assert.equal(negotiateLocale('fr-FR'), 'en');
  assert.equal(negotiateLocale(undefined), 'en');
  assert.equal(negotiateLocale('en;q=0, zh'), 'zh', 'q=0 is not acceptable');
});

test('loginHtml renders a self-contained page with the error hook', () => {
  const plain = loginHtml();
  assert.match(plain, /<!doctype html>/i);
  assert.match(plain, /<form[^>]+method="post"/i);
  assert.match(plain, /action="\/frp-login"/i);
  assert.doesNotMatch(plain, /data-login-error/);

  const withError = loginHtml({ error: 'bad credentials' });
  assert.match(withError, /data-login-error/);
  assert.match(withError, /bad credentials/);
});

test('loginHtml is bilingual, self-contained, themeable and escapes its inputs', () => {
  const zh = loginHtml({ locale: 'zh' });
  assert.match(zh, /<!doctype html>/i);
  assert.match(zh, /lang="zh-CN"/);
  assert.match(zh, /<form[^>]+method="post"/i);
  assert.match(zh, /action="\/frp-login"/i);
  assert.match(zh, /name="username"/);
  assert.match(zh, /name="password"/);
  assert.doesNotMatch(zh, /data-login-error/, 'no error banner on a clean visit');
  assert.match(zh, /登录以继续|进入 DSH/);
  assert.match(zh, /frp/i);

  const en = loginHtml({ locale: 'en' });
  assert.match(en, /lang="en"/);
  assert.match(en, /Sign in to continue/);
  assert.match(en, /Enter DSH/);

  for (const page of [zh, en]) {
    assert.match(page, /id="theme"/, 'the page ships its own light/dark switch');
    assert.match(page, /data-theme/);
    assert.match(page, /prefers-color-scheme/, 'the first paint follows the system preference');
    assert.match(page, /localStorage/, 'the chosen theme is remembered');
    assert.doesNotMatch(page, /(src|href)="https?:\/\//i, 'no external resources');
  }

  const withError = loginHtml({ locale: 'zh', error: 'bad-credentials', domain: 'dsh.example.com' });
  assert.match(withError, /data-login-error/);
  assert.match(withError, /用户名或密码不正确/);
  assert.match(withError, /dsh\.example\.com/);

  const hostile = loginHtml({ locale: 'en', error: '<script>alert(1)</script>', domain: '<b>x</b>' });
  assert.doesNotMatch(hostile, /<script>alert\(1\)<\/script>/);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(hostile, /&lt;b&gt;/);
});
