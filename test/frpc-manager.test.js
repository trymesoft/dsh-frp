import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { spawn as spawnProcess } from 'node:child_process';

import { createFrpcManager } from '../frpc-manager.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-frpc.mjs');

async function waitFor(predicate, { timeout = 5000, interval = 15 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('condition not met within ' + timeout + 'ms');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function makeContext(overrides = {}) {
  const state = {
    spawns: [],
    tomls: [],
    creds: [],
    terminations: 0,
    env: {},
  };
  const config = {
    serverAddr: 'frp.example.com',
    serverPort: 17000,
    authToken: 'test-auth-token',
    useTls: true,
    domain: 'dsh.example.com',
    ...overrides.config,
  };
  const workDir = overrides.workDir;

  const defaultSpawn = (spec) => {
    state.spawns.push(spec);
    const [command, ...args] = spec.argv;
    const isScript = command.endsWith('.mjs');
    const child = spawnProcess(isScript ? process.execPath : command, isScript ? [command, ...args] : args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...state.env },
    });
    const done = new Promise((resolve) => {
      child.on('exit', (exitCode) => resolve({ exitCode }));
      child.on('error', () => resolve({ exitCode: null }));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      async terminate() {
        if (child.exitCode === null) child.kill('SIGTERM');
        await done;
      },
    };
  };
  const spawn = overrides.spawn ?? defaultSpawn;

  return {
    state,
    config,
    opts: {
      spawn,
      writeToml: async (content) => {
        state.tomls.push(content);
        const file = path.join(workDir, 'frpc-' + state.tomls.length + '.toml');
        await fsp.writeFile(file, content, { mode: 0o600 });
        return file;
      },
      binaryPath: () => STUB,
      config: () => config,
      gatewayPort: () => 51234,
      persistAdminCreds: async (creds) => {
        state.creds.push(creds);
      },
      adminPollMs: 20,
      backoff: { initialMs: 40, maxMs: 120, maxConsecutiveFails: 5 },
      ...overrides.opts,
    },
  };
}

test('manager starts frpc, writes a TOML with fresh admin credentials and reaches running', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  ctx.state.env.STUB_DESCRIBE = '1';
  const manager = createFrpcManager(ctx.opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');

    assert.equal(ctx.state.spawns.length, 1);
    assert.equal(ctx.state.creds.length, 1);
    const toml = ctx.state.tomls[0];
    assert.match(toml, /webServer\.port = \d+/);
    assert.ok(toml.includes('webServer.user = "' + ctx.state.creds[0].user + '"'));
    assert.ok(toml.includes('webServer.password = "' + ctx.state.creds[0].password + '"'));
    assert.ok(toml.includes('localPort = 51234'));
    assert.ok(toml.includes('customDomains = ["dsh.example.com"]'));
    assert.ok(toml.includes('auth.token = "' + ctx.config.authToken + '"'));

    await waitFor(() => manager.logs().some((line) => line.includes('stub-frpc tick')));
    assert.equal(manager.status().proxyState, 'running');
  } finally {
    await manager.stop();
  }
});

test('manager restarts after an unexpected exit and returns to running', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  ctx.state.env.STUB_EXIT_AFTER_MS = '250';
  const manager = createFrpcManager(ctx.opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    await waitFor(() => ctx.state.spawns.length >= 2, { timeout: 6000 });
    await waitFor(() => manager.status().state === 'running', { timeout: 6000 });
    assert.ok(ctx.state.tomls.length >= 2, 'each start regenerates the TOML');
    const firstProxy = ctx.state.tomls[0].match(/name = "([^"]+)"/)[1];
    const secondProxy = ctx.state.tomls[1].match(/name = "([^"]+)"/)[1];
    assert.notEqual(firstProxy, secondProxy, 'the proxy name changes per start');
  } finally {
    await manager.stop();
  }
});

test('five consecutive fast failures end in the error state without further restarts', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  ctx.state.env.STUB_FAST_EXIT = '1';
  ctx.state.env.STUB_DESCRIBE = '1';
  const manager = createFrpcManager(ctx.opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'error', { timeout: 8000 });
    const spawnsAtError = ctx.state.spawns.length;
    assert.equal(spawnsAtError, 5, 'exactly the configured number of attempts');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(ctx.state.spawns.length, spawnsAtError, 'no restart after the error state');
    assert.match(manager.status().message ?? '', /fail/i);
  } finally {
    await manager.stop();
  }
});

test('a slow-starting admin API stays starting and is never reported running early', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  ctx.state.env.STUB_SLOW_MS = '700';
  const manager = createFrpcManager(ctx.opts);
  try {
    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(manager.status().state, 'starting');
    await waitFor(() => manager.status().state === 'running', { timeout: 6000 });
  } finally {
    await manager.stop();
  }
});

test('killImmediately terminates the child and stops restarting', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  const manager = createFrpcManager(ctx.opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    await manager.killImmediately();
    assert.equal(manager.status().state, 'stopped');
    const spawns = ctx.state.spawns.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ctx.state.spawns.length, spawns, 'no restart after killImmediately');
  } finally {
    await manager.stop();
  }
});

test('onStateChange reports transitions and can be unsubscribed', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const ctx = makeContext({ workDir });
  const manager = createFrpcManager(ctx.opts);
  const seen = [];
  const unsubscribe = manager.onStateChange((status) => seen.push(status.state));
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    assert.deepEqual(seen.slice(0, 2), ['starting', 'running']);
    unsubscribe();
    await manager.stop();
    assert.deepEqual(seen.slice(-1), ['running']);
  } finally {
    await manager.stop();
  }
});
