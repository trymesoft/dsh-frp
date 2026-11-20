import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';

import { Config, apply } from '../src/index.js';
import { createPanelApi, exchangeDshCookie } from '../src/status-routes.js';
import { NoChecksumError } from '../src/frpc-manager.js';

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

async function bootPlugin({ config = {}, editor, withConfigEditor = true, entry } = {}) {
  const registered = [];
  const disposers = [];
  // Captured so a test can tell which branch of the activation path ran, when
  // the branch itself is the behaviour under test.
  const logs = [];
  let currentConfig = { ...Config, ...config };
  const fiberEntry = entry ?? {
    options: { id: 'dsh-frp', name: 'dsh-frp', config: {} },
    fiber: { state: 'active' },
  };
  const ctx = {
    fiber: { entry: fiberEntry },
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
    get: (name) => {
      if (name !== 'configEditor' || !withConfigEditor) return undefined;
      // Mirrors ConfigEditor.edit(entry, change): the argument is a Loader
      // entry, and a row id is refused, exactly as the Host does.
      return editor ?? {
        edit: async (target, change) => {
          if (target !== fiberEntry) throw new Error('Configuration entry is no longer available');
          const next = change({ ...(target.options.config ?? {}) }, {});
          target.options.config = next;
          currentConfig = next;
        },
      };
    },
    effect: (fn) => {
      disposers.push(fn());
    },
    logger: { info: (message) => void logs.push(String(message)), warn: (message) => void logs.push(String(message)) },
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
  return { handler: registered[0].handler, disposers, close, getConfig: () => currentConfig, entry: fiberEntry, logs };
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
      // The envelope carries the failure; a non-2xx would make the GUI's rpc
      // client throw a transport error and hide the reason from the panel.
      assert.equal(status, 200);
      assert.equal(body.type, 'server-response');
      assert.equal(body.rpcId, 'rpc-2');
      assert.equal(body.result.ok, false);
      assert.equal(body.result.error.code, 'start-gate');
      assert.equal(typeof body.result.error.message, 'string');
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

test('a panel save persists through the config editor and is visible afterwards', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    try {
      const { handler, close, getConfig, entry } = await bootPlugin({ config: { login: { username: 'owner' } } });
      try {
        const saved = await panel(handler, 'setFrpsConfig', {
          serverAddr: 'frp.example.com',
          serverPort: 17000,
          domain: 'dsh.example.com',
          publicBaseUrl: 'https://dsh.example.com',
          useTLS: true,
        }, 'rpc-save-1');
        assert.equal(saved.body.result.ok, true, 'the save must not report a failure');
        assert.equal(saved.body.result.value.restartRequired, true);

        // The persisted row is what the next `apply` reads.
        assert.equal(entry.options.config.frps.serverAddr, 'frp.example.com');
        assert.equal(entry.options.config.frps.serverPort, 17000);
        assert.equal(entry.options.config.publicBaseUrl, 'https://dsh.example.com');
        assert.equal(getConfig().frps.domain, 'dsh.example.com');

        // And the panel reads the saved values back.
        const status = await panel(handler, 'status', {}, 'rpc-save-2');
        assert.equal(status.body.result.value.serverAddr, 'frp.example.com');
        assert.equal(status.body.result.value.domain, 'dsh.example.com');
        assert.deepEqual(status.body.result.value.missing.includes('frps-domain'), false);
      } finally {
        await close();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('a save without a config editor fails loudly instead of pretending to persist', async () => {
  await withTempHome(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    try {
      const { handler, close, getConfig } = await bootPlugin({ withConfigEditor: false });
      try {
        const saved = await panel(handler, 'setFrpsConfig', {
          serverAddr: 'frp.example.com',
          serverPort: 17000,
          domain: 'dsh.example.com',
          publicBaseUrl: 'https://dsh.example.com',
        }, 'rpc-save-3');
        assert.equal(saved.body.result.ok, false);
        assert.match(saved.body.result.error.message, /config/i);
        assert.equal(getConfig().frps?.serverAddr ?? '', '', 'the live config must not move on an unsaved value');
      } finally {
        await close();
      }
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

test('a cached frpc is reported as present before the first start', async () => {
  await withTempHome(async (home) => {
    const cached = path.join(home, 'dsh-frp', 'bin', 'frp_0.72.0_' + process.platform + '_' + process.arch, 'frpc');
    await fs.promises.mkdir(path.dirname(cached), { recursive: true });
    await fs.promises.writeFile(cached, '#!/bin/sh\n', { mode: 0o755 });

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 303, headers: { getSetCookie: () => ['a=b; Path=/'] } });
    try {
      const { handler, close } = await bootPlugin();
      try {
        await panel(handler, 'setLogin', { username: 'owner', password: 'a-long-enough-password' }, 'rpc-l');
        await panel(handler, 'setFrpsToken', { token: 'tok' }, 'rpc-t');
        await panel(handler, 'setFrpsConfig', {
          serverAddr: 'frp.example.com',
          serverPort: 17000,
          domain: 'dsh.example.com',
          publicBaseUrl: 'https://dsh.example.com',
        }, 'rpc-c');

        const { body } = await panel(handler, 'status', {}, 'rpc-s');
        const status = body.result.value;
        // The binary is on disk, so the panel must not claim it is missing and
        // must not tell the user to download it again.
        assert.equal(status.state, 'stopped');
        assert.equal(status.reason, undefined);
        assert.equal(status.binaryPath, cached);
        assert.equal(status.configuredBinaryPath, '');
      } finally {
        await close();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('saving the values that are already live does not reload the plugin', async () => {
  await withTempHome(async () => {
    let edits = 0;
    const editor = {
      edit: async () => {
        edits += 1;
      },
    };
    const { handler, close } = await bootPlugin({ editor });
    try {
      const values = {
        serverAddr: 'frp.example.com',
        serverPort: 17000,
        domain: 'dsh.example.com',
        publicBaseUrl: 'https://dsh.example.com',
      };
      const first = await panel(handler, 'setFrpsConfig', values, 'rpc-1');
      assert.equal(first.body.result.ok, true);
      assert.equal(edits, 1, 'a real change is persisted');

      // The reload an edit triggers drops the running tunnel, so a save that
      // changes nothing must not go through the config editor at all.
      const second = await panel(handler, 'setFrpsConfig', { ...values, domain: 'DSH.example.com' }, 'rpc-2');
      assert.equal(second.body.result.ok, true);
      assert.equal(edits, 1, 'an unchanged save does not reload the plugin');
    } finally {
      await close();
    }
  });
});

test('toggling autoStart reaches the config editor once, a repeated value never does', async () => {
  await withTempHome(async () => {
    let edits = 0;
    const editor = {
      edit: async () => {
        edits += 1;
      },
    };
    const { handler, close } = await bootPlugin({ config: { autoStart: false }, editor });
    try {
      const first = await panel(handler, 'setAutoStart', { autoStart: true }, 'rpc-1');
      assert.equal(first.body.result.ok, true);
      assert.equal(edits, 1, 'a real change is persisted');

      // The reload an edit triggers drops the running tunnel, so re-sending the
      // value that is already live must not reach the config editor at all.
      const second = await panel(handler, 'setAutoStart', { autoStart: true }, 'rpc-2');
      assert.equal(second.body.result.ok, true);
      assert.equal(edits, 1, 'an unchanged save does not reload the plugin');

      // The panel confirms a save from the status it polls with `expect`, so the
      // round-trip has to land in status for the confirmation to ever resolve.
      const after = await panel(handler, 'status', {}, 'rpc-3');
      assert.equal(after.body.result.value.autoStart, true, 'status carries the saved value');
    } finally {
      await close();
    }
  });
});

test('autoStart on an unconfigured profile loads without starting anything', async () => {
  await withTempHome(async () => {
    const { handler, close, logs } = await bootPlugin({ config: { autoStart: true } });
    try {
      const { body } = await panel(handler, 'status', {}, 'rpc-1');
      assert.equal(body.result.value.state, 'not-configured', 'the gate still decides, not the flag');
      // Status alone would read `not-configured` even if the flag had bypassed
      // the gate and tried to fetch the binary, because the state is derived
      // from the gate either way. The skip line is the branch: it is logged
      // before any binary work, so its presence means no download was attempted.
      assert.ok(
        logs.some((line) => line.includes('autoStart skipped, missing')),
        'the load path took the skip branch instead of touching the binary',
      );
    } finally {
      await close();
    }
  });
});
