import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStartGate,
  exchangeDshCookie,
  createPanelApi,
  PLUGIN_SCOPES,
} from '../src/status-routes.js';
import { SessionAuthority } from '../src/gateway-session.js';

const PASSWORD = 'a-long-enough-password';
const GOOD_CONFIG = {
  login: { username: 'owner' },
  frps: { serverAddr: 'frp.example.com', serverPort: 17000, domain: 'dsh.example.com', transport: { useTLS: true } },
  publicBaseUrl: 'https://dsh.example.com',
};

function makeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: async (key) => data.get(key),
    write: async (key, value) => {
      data.set(key, value);
    },
  };
}

function makeDeps(overrides = {}) {
  const store = overrides.store ?? makeStore({ [PLUGIN_SCOPES.loginPassword]: PASSWORD, [PLUGIN_SCOPES.frpsToken]: 'tok' });
  const edits = [];
  let config = overrides.config ?? GOOD_CONFIG;
  const state = { started: 0, stopped: 0, state: 'stopped', message: undefined, reason: undefined, proxyState: undefined, logs: ['line-1'] };
  const manager = {
    start: async () => {
      state.started += 1;
      state.state = 'running';
    },
    stop: async () => {
      state.stopped += 1;
      state.state = 'stopped';
    },
    status: () => ({ state: state.state, message: state.message, reason: state.reason, proxyState: state.proxyState }),
    logs: () => state.logs,
  };
  const deps = {
    config: () => config,
    credentials: store,
    editor: {
      edit: async (updater) => {
        edits.push(updater);
        config = updater(config);
      },
    },
    manager,
    gatewayPort: () => 51234,
    ensureBinary: async () => '/cache/frpc',
    binaryPresent: () => '/cache/frpc',
    downloadState: () => ({ pct: undefined }),
    checksumAvailable: () => true,
    platform: () => ({ platform: 'darwin', arch: 'arm64' }),
    ...overrides.deps,
  };
  return { deps, store, edits, managerState: state, getConfig: () => config };
}

test('computeStartGate names every missing prerequisite', () => {
  const ok = computeStartGate(GOOD_CONFIG, { loginPassword: PASSWORD, frpsToken: 'tok' });
  assert.deepEqual(ok, { ok: true, missing: [] });

  const noPassword = computeStartGate(GOOD_CONFIG, { frpsToken: 'tok' });
  assert.equal(noPassword.ok, false);
  assert.ok(noPassword.missing.includes('login-password'));

  const noUsername = computeStartGate({ ...GOOD_CONFIG, login: { username: '' } }, { loginPassword: PASSWORD, frpsToken: 'tok' });
  assert.ok(noUsername.missing.includes('login-username'));

  const noFrps = computeStartGate({ ...GOOD_CONFIG, frps: { serverAddr: '', serverPort: 17000, domain: '' }, publicBaseUrl: '' }, {});
  assert.deepEqual(noFrps.missing.sort(), ['frps-domain', 'frps-server-addr', 'frps-token', 'login-password', 'public-base-url'].sort());
});

test('exchangeDshCookie keeps only name=value pairs from a 303', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 303,
      headers: {
        getSetCookie: () => ['dsh-auth-abc=SIGNED; Path=/; HttpOnly', 'other=1; Path=/'],
      },
    };
  };
  const cookie = await exchangeDshCookie({ authenticatedUrl: 'http://127.0.0.1:1/?token=launch', origin: 'http://127.0.0.1:1', fetchImpl });
  assert.equal(cookie, 'dsh-auth-abc=SIGNED; other=1');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].url, 'http://127.0.0.1:1/?token=launch');
});

test('exchangeDshCookie refuses a non-303 answer and an empty cookie jar', async () => {
  await assert.rejects(
    exchangeDshCookie({ authenticatedUrl: 'http://127.0.0.1:1/?token=t', origin: 'http://127.0.0.1:1', fetchImpl: async () => ({ status: 401, headers: { getSetCookie: () => [] } }) }),
    /303/,
  );
  await assert.rejects(
    exchangeDshCookie({ authenticatedUrl: 'http://127.0.0.1:1/?token=t', origin: 'http://127.0.0.1:1', fetchImpl: async () => ({ status: 303, headers: { getSetCookie: () => [] } }) }),
    /cookie/i,
  );
});

test('setLogin bumps the stored epoch and kills old sessions', async () => {
  const store = makeStore({
    [PLUGIN_SCOPES.loginPassword]: PASSWORD,
    [PLUGIN_SCOPES.frpsToken]: 'tok',
    [PLUGIN_SCOPES.sessionEpoch]: 3,
  });
  const { deps } = makeDeps({ store });
  const api = createPanelApi(deps);

  const authority = new SessionAuthority({
    signingSecret: 'secret',
    epoch: () => Number(store.data.get(PLUGIN_SCOPES.sessionEpoch) ?? 0),
    ttlHours: 12,
    secure: false,
    cookieName: 'gw-session',
  });
  const now = Date.now();
  const oldCookie = authority.issue(now);
  assert.equal(authority.verify(oldCookie, now + 1000), true);

  await api.endpoint('setLogin', { username: 'owner', password: 'another-long-password' });
  assert.equal(store.data.get(PLUGIN_SCOPES.loginPassword), 'another-long-password');
  assert.equal(Number(store.data.get(PLUGIN_SCOPES.sessionEpoch)), 4);
  assert.equal(authority.verify(oldCookie, now + 1000), false, 'old sessions die on a password change');
});

test('setLogin rejects a short password and an empty username', async () => {
  const { deps } = makeDeps();
  const api = createPanelApi(deps);
  await assert.rejects(api.endpoint('setLogin', { username: 'owner', password: 'short' }), /12/);
  await assert.rejects(api.endpoint('setLogin', { username: '', password: PASSWORD }), /username/i);
});

test('start refuses to run when the gate reports missing prerequisites', async () => {
  const store = makeStore({ [PLUGIN_SCOPES.frpsToken]: 'tok' });
  const { deps, managerState } = makeDeps({ store });
  const api = createPanelApi(deps);
  await assert.rejects(api.endpoint('start', {}), (error) => {
    assert.ok(Array.isArray(error.missing));
    assert.ok(error.missing.includes('login-password'));
    assert.equal(error.code, 'start-gate');
    assert.deepEqual(error.details.missing, error.missing);
    return true;
  });
  assert.equal(managerState.started, 0);
});

test('start runs the manager once the gate passes', async () => {
  const { deps, managerState } = makeDeps();
  const api = createPanelApi(deps);
  const result = await api.endpoint('start', {});
  assert.equal(managerState.started, 1);
  assert.equal(result.state, 'running');
});

test('setFrpsConfig persists through the config editor and reports a restart', async () => {
  const { deps, edits, getConfig } = makeDeps();
  const api = createPanelApi(deps);
  const result = await api.endpoint('setFrpsConfig', { serverAddr: 'frp2.example.com', serverPort: 17001 });
  assert.equal(edits.length, 1);
  assert.equal(getConfig().frps.serverAddr, 'frp2.example.com');
  assert.equal(getConfig().frps.serverPort, 17001);
  assert.deepEqual(result, { restartRequired: true });
});

test('setFrpsConfig rejects an invalid domain, port or public URL', async () => {
  const { deps } = makeDeps();
  const api = createPanelApi(deps);
  await assert.rejects(api.endpoint('setFrpsConfig', { domain: 'has space.example.com' }), /domain/i);
  await assert.rejects(api.endpoint('setFrpsConfig', { serverPort: 70000 }), /port/i);
  await assert.rejects(api.endpoint('setFrpsConfig', { publicBaseUrl: 'ftp://x' }), /public/i);
  await assert.rejects(api.endpoint('setFrpsConfig', { serverAddr: 'a\nb' }), /serverAddr|newline/i);
});

test('rejections carry a code and the field, so the panel can speak its own language', async () => {
  const { deps } = makeDeps();
  const api = createPanelApi(deps);
  // The Host keeps its English diagnostics, but the panel localizes by code.
  await assert.rejects(api.endpoint('setFrpsConfig', { domain: 'has space.example.com' }), (error) => {
    assert.equal(error.code, 'invalid-domain');
    assert.equal(error.details.field, 'domain');
    return true;
  });
  await assert.rejects(api.endpoint('setFrpsConfig', { serverPort: 70000 }), (error) => {
    assert.equal(error.code, 'invalid-port');
    assert.equal(error.details.field, 'serverPort');
    return true;
  });
  await assert.rejects(api.endpoint('setFrpsConfig', { publicBaseUrl: 'ftp://x' }), (error) => {
    assert.equal(error.code, 'invalid-url');
    return true;
  });
  await assert.rejects(api.endpoint('setFrpsConfig', { serverAddr: '' }), (error) => {
    assert.equal(error.code, 'empty-field');
    assert.equal(error.details.field, 'serverAddr');
    return true;
  });
  await assert.rejects(api.endpoint('setLogin', { username: 'owner', password: 'short' }), (error) => {
    assert.equal(error.code, 'password-too-short');
    assert.equal(error.details.min, 12);
    return true;
  });
});

test('the not-configured state is a reason code, never an English sentence', async () => {
  const store = makeStore({ [PLUGIN_SCOPES.frpsToken]: 'tok' });
  const { deps } = makeDeps({ store, config: { ...GOOD_CONFIG, login: { username: '' } } });
  const status = await createPanelApi(deps).endpoint('status', {});
  assert.equal(status.state, 'not-configured');
  assert.equal(status.message, undefined, 'the panel owns the wording');
  assert.equal(status.reason.code, 'not-configured');
  assert.ok(status.reason.params.missing.includes('login-password'));
  assert.ok(status.reason.params.missing.includes('login-username'));
});

test('manager reasons reach the panel untouched', async () => {
  const { deps, managerState } = makeDeps();
  const api = createPanelApi(deps);
  await api.endpoint('start', {});
  managerState.state = 'error';
  managerState.message = 'frps rejected the proxy: start error';
  managerState.reason = { code: 'proxy-error', params: { status: 'start error', detail: 'port already used' } };
  const status = await api.endpoint('status', {});
  assert.deepEqual(status.reason, { code: 'proxy-error', params: { status: 'start error', detail: 'port already used' } });
  assert.equal(status.message, 'frps rejected the proxy: start error');
});

test('chooseBinary writes the path through the editor and echoes restartRequired', async () => {
  const { deps, edits, getConfig } = makeDeps();
  const api = createPanelApi(deps);
  const result = await api.endpoint('chooseBinary', { mode: 'path', path: '/opt/frp/frpc' });
  assert.equal(edits.length, 1);
  assert.equal(getConfig().frpc.binaryPath, '/opt/frp/frpc');
  assert.deepEqual(result, { restartRequired: true });

  const download = await api.endpoint('chooseBinary', { mode: 'download' });
  assert.equal(getConfig().frpc.binaryPath, '');
  assert.deepEqual(download, { restartRequired: true });
});

test('setAutoStart persists the flag through the config editor', async () => {
  const { deps, edits, getConfig } = makeDeps({ config: { ...GOOD_CONFIG, autoStart: false } });
  const api = createPanelApi(deps);
  const result = await api.endpoint('setAutoStart', { autoStart: true });
  assert.deepEqual(result, { restartRequired: true });
  assert.equal(getConfig().autoStart, true, 'the persisted config carries the new value');
  assert.equal(edits.length, 1, 'the change goes through the config editor');
});

test('setAutoStart refuses anything but a boolean', async () => {
  const { deps, edits } = makeDeps({ config: { ...GOOD_CONFIG, autoStart: false } });
  const api = createPanelApi(deps);
  for (const payload of [{ autoStart: 'false' }, { autoStart: 0 }, {}, undefined]) {
    await assert.rejects(() => api.endpoint('setAutoStart', payload), (error) => {
      assert.equal(error.code, 'invalid-auto-start');
      assert.equal(error.details.field, 'autoStart');
      return true;
    });
  }
  assert.equal(edits.length, 0, 'a refused value never reaches the config editor');
});

test('setFrpsToken and getLogs round-trip', async () => {
  const { deps, store } = makeDeps();
  const api = createPanelApi(deps);
  await api.endpoint('setFrpsToken', { token: 'new-token' });
  assert.equal(store.data.get(PLUGIN_SCOPES.frpsToken), 'new-token');
  const logs = await api.endpoint('getLogs', {});
  assert.deepEqual(logs.lines, ['line-1']);
});

test('status composes the panel states: not-configured, need-binary, running', async () => {
  const missingPassword = makeDeps({ store: makeStore({ [PLUGIN_SCOPES.frpsToken]: 'tok' }) });
  const notConfigured = createPanelApi(missingPassword.deps);
  const first = await notConfigured.endpoint('status', {});
  assert.equal(first.state, 'not-configured');
  assert.ok(first.missing.includes('login-password'));
  assert.equal(first.publicUrl, 'https://dsh.example.com');

  const noBinary = makeDeps({ deps: { binaryPresent: () => undefined } });
  const needBinary = await createPanelApi(noBinary.deps).endpoint('status', {});
  assert.equal(needBinary.state, 'need-binary');

  const ready = makeDeps();
  const api = createPanelApi(ready.deps);
  await api.endpoint('start', {});
  const running = await api.endpoint('status', {});
  assert.equal(running.state, 'running');
  assert.equal(running.publicUrl, 'https://dsh.example.com');
  assert.deepEqual(running.logsTail, ['line-1']);
  assert.equal(running.binaryPath, '/cache/frpc');
  assert.equal(running.configuredBinaryPath, '', 'download mode seeds the form from an empty configured path');
});

test('status separates the configured binary path from the binary in use', async () => {
  const configured = makeDeps({
    config: { ...GOOD_CONFIG, frpc: { binaryPath: '/opt/frp/frpc' } },
  });
  const status = await createPanelApi(configured.deps).endpoint('status', {});
  assert.equal(status.binaryMode, 'path');
  assert.equal(status.configuredBinaryPath, '/opt/frp/frpc');
  assert.equal(status.binaryPath, '/cache/frpc', 'the running binary is the resolved one');
});
