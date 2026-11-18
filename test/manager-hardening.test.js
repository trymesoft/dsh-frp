import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';

import { createFrpcManager } from '../frpc-manager.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-frpc.mjs');

async function waitFor(predicate, { timeout = 8000, interval = 15 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('condition not met within ' + timeout + 'ms');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function makeContext(workDir, { env = {}, backoff, writeToml } = {}) {
  const state = { spawns: [], terminations: 0 };
  const spawn = (spec) => {
    const extra = typeof env === 'function' ? env(state.spawns.length) : env;
    state.spawns.push(spec);
    const child = spawnProcess(process.execPath, [STUB, ...spec.argv.slice(1)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extra } });
    const done = new Promise((resolve) => {
      child.on('exit', (exitCode) => resolve({ exitCode }));
      child.on('error', () => resolve({ exitCode: null }));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      async terminate() {
        state.terminations += 1;
        if (child.exitCode === null) child.kill('SIGTERM');
        await done;
      },
    };
  };
  const opts = {
    spawn,
    writeToml:
      writeToml ??
      (async (content) => {
        const file = path.join(workDir, 'frpc-' + state.spawns.length + '.toml');
        await fsp.writeFile(file, content, { mode: 0o600 });
        return file;
      }),
    binaryPath: () => STUB,
    config: () => ({ serverAddr: 'frp.example.com', serverPort: 17000, authToken: 'tok', useTls: true, domain: 'dsh.example.com' }),
    gatewayPort: () => 51234,
    persistAdminCreds: async () => {},
    adminPollMs: 20,
    backoff: backoff ?? { initialMs: 40, maxMs: 120, maxConsecutiveFails: 5 },
  };
  return { opts, state };
}

test('a restart whose setup throws reports an error instead of crashing the process', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  let writes = 0;
  const { opts, state } = makeContext(workDir, {
    env: { STUB_EXIT_AFTER_MS: '150' },
    writeToml: async (content) => {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
      const file = path.join(workDir, 'frpc.toml');
      await fsp.writeFile(file, content, { mode: 0o600 });
      return file;
    },
  });
  const manager = createFrpcManager(opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    await waitFor(() => manager.status().state === 'error');
    assert.match(manager.status().message ?? '', /disk full/);
    assert.equal(state.spawns.length, 1, 'the failing launch never spawned');
  } finally {
    await manager.stop();
  }
});

test('start() during a pending backoff does not spawn a second frpc', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const { opts, state } = makeContext(workDir, {
    // Only the first child dies; the relaunched one stays up so a third spawn
    // can only come from the stale timer this test is about.
    env: (index) => (index === 0 ? { STUB_EXIT_AFTER_MS: '200' } : {}),
    backoff: { initialMs: 800, maxMs: 800, maxConsecutiveFails: 5 },
  });
  const manager = createFrpcManager(opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    await waitFor(() => manager.status().state === 'starting');
    await manager.start();
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    assert.equal(state.spawns.length, 2, 'an explicit start relaunches exactly once');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(state.spawns.length, 2, 'the cancelled backoff timer must not fire a third child');
  } finally {
    await manager.stop();
  }
});

test('a stale exit from a stopped child cannot disturb a fresh one', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const { opts, state } = makeContext(workDir, { env: {} });
  const manager = createFrpcManager(opts);
  try {
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    await manager.stop();
    await manager.start();
    await waitFor(() => manager.status().state === 'running');
    assert.equal(state.spawns.length, 2);
    assert.equal(manager.status().state, 'running', 'the fresh child stays supervised');
    await manager.stop();
    assert.equal(state.terminations, 2, 'both children were terminated');
  } finally {
    await manager.stop();
  }
});
