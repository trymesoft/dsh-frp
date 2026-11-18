import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';

import { Config, apply } from '../index.js';
import { createPanelApi, exchangeDshCookie } from '../status-routes.js';
import { NoChecksumError } from '../frpc-manager.js';

function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers ?? {};
    },
    end(body) {
      captured.body = body ?? '';
    },
  };
}

function fakeRequest({ method = 'POST', url = '/dsh-frp/status', body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function envelope(method, payload, rpcId = 'rpc-' + method) {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload });
}

async function withTempHome(fn) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

async function bootPlugin({ config = {}, editor } = {}) {
  const registered = [];
  const disposers = [];
  let currentConfig = { ...Config, ...config };
  const ctx = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:55570',
      register: (route) => {
        registered.push(route);
        return async () => {};
      },
    },
    connection: {
      authenticatedUrl: (url) => url + '?token=launch-token',
      requestRejection: () => undefined,
    },
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:55570' },
    subprocess: { spawn: () => ({ stdout: null, stderr: null, done: new Promise(() => {}), terminate: async () => {} }) },
    get: (name) =>
      name === 'configEditor'
        ? editor ?? {
            edit: async (id, updater) => {
              currentConfig = updater(currentConfig);
            },
          }
        : undefined,
    effect: (fn) => {
      disposers.push(fn());
    },
    logger: { info: () => {}, warn: () => {} },
  };
  await apply(ctx, currentConfig);
  const close = async () => {
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch {
        /* best effort */
      }
    }
  };
  return { handler: registered[0].handler, disposers, close, getConfig: () => currentConfig };
}

async function panel(handler, method, payload, rpcId) {
  const res = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-frp/' + method, body: envelope(method, payload, rpcId) }), res);
  const body = JSON.parse(res.captured.body);
  return { status: res.captured.status, body };
}

function httpRequest(port, { method = 'GET', path: pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { Host: '127.0.0.1:' + port, ...headers } },
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

test('the panel route answers the connection rpc envelope on success', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    try {
      const { handler, close } = await bootPlugin();
      try {
      const { status, body } = await panel(handler, 'status', {}, 'rpc-1');
      assert.equal(status, 200);
      assert.equal(body.type, 'server-response');
      assert.equal(body.rpcId, 'rpc-1');
      assert.equal(body.result.ok, true);
      assert.equal(body.result.value.state, 'not-configured');
      } finally { await close(); }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('the panel route answers the envelope shape on failure too', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    try {
      const { handler, close } = await bootPlugin();
      try {
      const { status, body } = await panel(handler, 'start', {}, 'rpc-2');
      assert.equal(status, 409);
      assert.equal(body.type, 'server-response');
      assert.equal(body.rpcId, 'rpc-2');
      assert.equal(body.result.ok, false);
      assert.equal(typeof body.result.error.code, 'string');
      assert.equal(typeof body.result.error.message, 'string');
      assert.deepEqual(body.result.error.details, { missing: body.result.error.details.missing });
      assert.ok(Array.isArray(body.result.error.details.missing));
      assert.ok(body.result.error.details.missing.includes('login-password'));
      } finally { await close(); }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('a password change kills sessions that the gateway already handed out', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['dsh-auth-abc=SIGNED; Path=/'] } });
    try {
      const { handler, close } = await bootPlugin({ config: { login: { username: 'owner' } } });
      try {
      const first = await panel(handler, 'setLogin', { username: 'owner', password: 'first-password-1' }, 'rpc-3');
      assert.equal(first.body.result.ok, true);

      const statusRes = await panel(handler, 'status', {}, 'rpc-4');
      const gatewayPort = statusRes.body.result.value.gatewayPort;
      assert.ok(gatewayPort > 0);

      const form = 'username=owner&password=first-password-1';
      const login = await httpRequest(gatewayPort, {
        method: 'POST',
        path: '/frp-login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
        body: form,
      });
      assert.equal(login.status, 302);
      const sessionCookie = String(login.headers['set-cookie']).split(';')[0];

      const before = await httpRequest(gatewayPort, { path: '/api/probe', headers: { Cookie: sessionCookie } });
      assert.notEqual(before.status, 302, 'the session works before the password change');

      await panel(handler, 'setLogin', { username: 'owner', password: 'second-password-2' }, 'rpc-5');

      const after = await httpRequest(gatewayPort, { path: '/api/probe', headers: { Cookie: sessionCookie } });
      assert.equal(after.status, 302, 'the old cookie must be dead after a password change');
      } finally { await close(); }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('status exposes gateway health so a dead gateway is not reported as a stopped tunnel', async () => {
  const deps = {
    config: () => ({
      login: { username: 'owner' },
      frps: { serverAddr: 'frp.example.com', serverPort: 17000, domain: 'dsh.example.com', transport: { useTLS: true } },
      publicBaseUrl: 'https://dsh.example.com',
      frpc: { binaryPath: '', downloadVersion: '0.72.0' },
    }),
    credentials: { read: async (key) => (key.endsWith('login-password') ? 'p'.repeat(20) : 'tok'), write: async () => {} },
    editor: { edit: async () => {} },
    manager: { start: async () => {}, stop: async () => {}, status: () => ({ state: 'stopped' }), logs: () => [] },
    gatewayPort: () => 51234,
    ensureBinary: async () => '/cache/frpc',
    binaryPresent: () => '/cache/frpc',
    downloadState: () => ({ pct: undefined }),
    checksumAvailable: () => true,
    confirmNoChecksum: async () => {},
    noChecksumConfirmed: () => false,
    platform: () => ({ platform: 'darwin', arch: 'arm64' }),
    gatewayState: () => ({ ok: false, message: 'gateway stopped listening' }),
  };
  const api = createPanelApi(deps);
  const status = await api.endpoint('status', {});
  assert.equal(status.state, 'stopped');
  assert.equal(status.gateway, 'error');
  assert.match(status.gatewayMessage, /gateway/);
});

test('the download endpoint runs the download itself and reports a no-checksum code', async () => {
  let calls = 0;
  let fail = true;
  const deps = {
    config: () => ({
      login: { username: 'owner' },
      frps: { serverAddr: 'a', serverPort: 1, domain: 'dsh.example.com', transport: { useTLS: true } },
      publicBaseUrl: 'https://dsh.example.com',
      frpc: { binaryPath: '' },
    }),
    credentials: { read: async (key) => (key.endsWith('login-password') ? 'p'.repeat(20) : 'tok'), write: async () => {} },
    editor: { edit: async () => {} },
    manager: { start: async () => {}, stop: async () => {}, status: () => ({ state: 'stopped' }), logs: () => [] },
    gatewayPort: () => 1,
    ensureBinary: async () => {
      calls += 1;
      if (fail) throw new NoChecksumError('no checksum');
      return '/cache/frpc';
    },
    binaryPresent: () => (fail ? undefined : '/cache/frpc'),
    downloadState: () => ({ pct: undefined }),
    checksumAvailable: () => false,
    confirmNoChecksum: async () => {},
    noChecksumConfirmed: () => false,
    platform: () => ({ platform: 'darwin', arch: 'arm64' }),
  };
  const api = createPanelApi(deps);

  const first = await api.endpoint('download', {}).then(
    () => assert.fail('must reject without consent'),
    (error) => error,
  );
  assert.equal(first.code, 'no-checksum');

  fail = false;
  const ok = await api.endpoint('download', { allowNoChecksum: true });
  assert.equal(ok.state, 'stopped');
  assert.ok(calls >= 2);
});

test('exchangeDshCookie mints on the origin authority, not the advertised URL', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { status: 303, headers: { getSetCookie: () => ['dsh-auth=1; Path=/'] } };
  };
  await exchangeDshCookie({
    authenticatedUrl: 'https://public.example.com/?token=abc',
    origin: 'http://127.0.0.1:55570',
    fetchImpl,
  });
  assert.equal(seen[0], 'http://127.0.0.1:55570/?token=abc');
});
