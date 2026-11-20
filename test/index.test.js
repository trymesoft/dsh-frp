import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Config, apply } from '../src/index.js';

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

test('the schema normalizes an empty row to the documented defaults', () => {
  const result = Config['~standard'].validate({});
  assert.equal(result.issues, undefined);
  const defaults = result.value;
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.autoStart, false);
  assert.equal(defaults.frps.serverPort, 7000);
  assert.equal(defaults.frps.transport.useTLS, true);
  assert.equal(defaults.frpc.downloadVersion, '0.72.0');
  assert.equal(defaults.gateway.sessionTtlHours, 12);
  assert.equal(Object.prototype.hasOwnProperty.call(defaults, 'token'), false, 'no secret keys in Config');
});

test('a hand-edited string autoStart fails closed instead of enabling the entrance', () => {
  // A quoted "false" in cordis.patch.yml is a plausible typo. Boolean(...) would
  // read it as true and turn the public entrance on at every boot, so the flag
  // the endpoint refuses to coerce must not be coerced on the way in either.
  for (const raw of ['false', '0', 'no']) {
    const result = Config['~standard'].validate({ autoStart: raw });
    assert.equal(result.value.autoStart, false, JSON.stringify(raw) + ' must not start the tunnel');
  }
  assert.equal(Config['~standard'].validate({ autoStart: true }).value.autoStart, true, 'a real boolean still counts');
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
    } finally {
      try {
        if (disposers.length > 0) await disposers[0]();
      } catch {
        /* best effort */
      }
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
      assert.ok(Array.isArray(body.error.details.missing));
      assert.ok(body.error.details.missing.includes('login-password'));
    } finally {
      try {
        if (disposers.length > 0) await disposers[0]();
      } catch {
        /* best effort */
      }
      globalThis.fetch = realFetch;
    }
  });
});

test('Config is a Standard Schema, the shape cordis validates through', () => {
  // cordis calls Config['~standard'].validate(raw); a bare object makes it
  // throw "cannot read properties of undefined (reading 'validate')".
  assert.equal(typeof Config['~standard'].validate, 'function');
  assert.equal(Config['~standard'].version, 1);

  const good = Config['~standard'].validate({
    frps: { serverAddr: 'frp.example.com', serverPort: 17000, domain: 'dsh.example.com' },
    publicBaseUrl: 'https://dsh.example.com',
  });
  assert.equal(good.issues, undefined);
  assert.equal(good.value.frps.serverPort, 17000);
  assert.equal(good.value.publicBaseUrl, 'https://dsh.example.com');

  const bad = Config['~standard'].validate({ frps: { serverPort: 70000, domain: 'not a domain' }, publicBaseUrl: 'ftp://x' });
  assert.ok(Array.isArray(bad.issues));
  assert.ok(bad.issues.length >= 3);
  assert.ok(bad.issues.some((issue) => issue.path.join('.') === 'frps.serverPort'));
});

test('secrets go into credential records as grant payloads when the service is present', async () => {
  await withTempHome(async (home) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });

    const records = new Map();
    const writes = [];
    const { ctx, disposers } = makeCtx();
    ctx.get = (serviceName) => {
      if (serviceName !== 'credentials') return undefined;
      return {
        async readRecord(key) {
          return records.get(key);
        },
        async modifyRecord(key, mutate) {
          assert.equal(typeof mutate, 'function', 'the record API takes a mutator, not a value');
          const record = await mutate();
          writes.push(key);
          records.set(key, record);
          return record;
        },
      };
    };

    try {
      await apply(ctx, { ...Config });
      const secret = records.get('dsh-frp/session-secret');
      assert.ok(secret, 'the session secret is stored as a record');
      assert.equal(secret.kind, 'grant');
      assert.equal(typeof secret.payload.value, 'string');
      assert.ok(secret.payload.value.length >= 32);
      assert.equal(records.get('dsh-frp/session-epoch').payload.value, '1');

      // The 0600 file fallback must stay unused while the service is present.
      const fallback = path.join(home, 'dsh-frp', 'credentials.json');
      await assert.rejects(fs.promises.stat(fallback));
      assert.deepEqual(writes.sort(), ['dsh-frp/session-epoch', 'dsh-frp/session-secret']);
    } finally {
      try {
        if (disposers.length > 0) await disposers[0]();
      } catch {
        /* best effort */
      }
      globalThis.fetch = realFetch;
    }
  });
});

test('Config normalizes the public entrance to its origin', () => {
  const out = Config['~standard'].validate({ publicBaseUrl: 'HTTPS://Dsh.Example.com/' });
  assert.equal(out.value.publicBaseUrl, 'https://dsh.example.com');
});
