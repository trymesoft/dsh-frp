import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Config, apply } from '../index.js';

function makeCtx() {
  const registered = [];
  const disposers = [];
  const state = { rejection: undefined };
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
      requestRejection: () => state.rejection,
    },
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:55570' },
    subprocess: {
      spawn: () => ({
        stdout: null,
        stderr: null,
        done: new Promise(() => {}),
        terminate: async () => {},
      }),
    },
    get: () => undefined,
    effect: (fn) => {
      disposers.push(fn());
    },
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, registered, disposers, state };
}

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

function fakeRequest({ method = 'GET', url = '/dsh-frp/status', body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

async function withTempHome(fn) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-frp-index-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('Config exposes the documented defaults', () => {
  assert.equal(Config.enabled, true);
  assert.equal(Config.autoStart, false);
  assert.equal(Config.frps.serverPort, 7000);
  assert.equal(Config.frps.transport.useTLS, true);
  assert.equal(Config.frpc.downloadVersion, '0.72.0');
  assert.equal(Config.gateway.sessionTtlHours, 12);
  assert.equal(Object.prototype.hasOwnProperty.call(Config, 'token'), false, 'no secret keys in Config');
});

test('apply mounts the panel prefix with a fence and answers status', async () => {
  await withTempHome(async (home) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 303,
      headers: { getSetCookie: () => ['dsh-auth-abc=SIGNED; Path=/'] },
    });
    const { ctx, registered, disposers, state } = makeCtx();
    try {
      await apply(ctx, { ...Config, autoStart: false });
      assert.equal(registered.length, 1);
      assert.equal(registered[0].kind, 'prefix');
      assert.equal(registered[0].path, '/dsh-frp');

      // The fence refuses unauthenticated panel traffic.
      state.rejection = 401;
      const denied = fakeResponse();
      await registered[0].handler(fakeRequest(), denied);
      assert.equal(denied.captured.status, 401);

      // Unconfigured plugin reports not-configured with the missing list.
      state.rejection = undefined;
      const ok = fakeResponse();
      await registered[0].handler(fakeRequest({ url: '/dsh-frp/status' }), ok);
      assert.equal(ok.captured.status, 200);
      const body = JSON.parse(ok.captured.body);
      assert.equal(body.state, 'not-configured');
      assert.ok(body.missing.includes('login-username'));

      // An unknown endpoint is a clean 400, not a crash.
      const unknown = fakeResponse();
      await registered[0].handler(fakeRequest({ url: '/dsh-frp/nope' }), unknown);
      assert.equal(unknown.captured.status, 400);

      assert.equal(disposers.length, 1);
      await disposers[0]();
    } finally {
      globalThis.fetch = realFetch;
    }
    const credentialsFile = path.join(home, 'dsh-frp', 'credentials.json');
    const written = JSON.parse(await fs.promises.readFile(credentialsFile, 'utf8'));
    assert.ok(written['dsh-frp/session-secret'], 'session secret persisted outside Config');
    const mode = (await fs.promises.stat(credentialsFile)).mode & 0o777;
    assert.equal(mode, 0o600, 'credential file is private');
  });
});

test('start through the panel is refused while the gate is open', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    const { ctx, registered, disposers } = makeCtx();
    try {
      await apply(ctx, { ...Config });
      const res = fakeResponse();
      await registered[0].handler(fakeRequest({ method: 'POST', url: '/dsh-frp/start', body: '{}' }), res);
      assert.equal(res.captured.status, 409);
      const body = JSON.parse(res.captured.body);
      assert.ok(Array.isArray(body.error.missing));
      assert.ok(body.error.missing.includes('login-password'));
      await disposers[0]();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
