import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { CHECKSUMS, ensureFrpcBinary, sha256File, ChecksumError, NoChecksumError } from '../src/frpc-manager.js';

const execFileAsync = promisify(execFile);
const VERSION = '0.72.0';
const PLATFORM = 'darwin';
const ARCH = 'arm64';
const ARCHIVE = 'frp_' + VERSION + '_' + PLATFORM + '_' + ARCH + '.tar.gz';

async function makeFixture(workDir, tamper, version = VERSION) {
  const pkgDir = path.join(workDir, 'frp_' + version + '_' + PLATFORM + '_' + ARCH);
  await fsp.mkdir(pkgDir, { recursive: true });
  const frpc = path.join(pkgDir, 'frpc');
  await fsp.writeFile(frpc, '#!/bin/sh\necho stub-frpc\n', { mode: 0o755 });
  const archive = path.join(workDir, 'frp_' + version + '_' + PLATFORM + '_' + ARCH + '.tar.gz');
  await execFileAsync('tar', ['-czf', archive, '-C', workDir, path.basename(pkgDir)]);
  let bytes = await fsp.readFile(archive);
  const good = createHash('sha256').update(bytes).digest('hex');
  if (tamper) {
    bytes = Buffer.from(bytes);
    bytes[bytes.length - 1] ^= 0xff;
  }
  return { bytes, good, archive };
}

async function serve(bytes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: server.address().port };
}

test('CHECKSUMS carries the pinned 0.72.0 entry for darwin arm64', () => {
  assert.equal(CHECKSUMS[VERSION + '_' + PLATFORM + '_' + ARCH], '6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8');
  assert.ok(Object.keys(CHECKSUMS).length >= 10, 'the table covers the platforms frp ships');
});

test('sha256File matches the archive hash', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const fixture = await makeFixture(workDir);
  assert.equal(await sha256File(fixture.archive), fixture.good);
});

test('a verified archive is extracted, made executable and cached', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const cacheDir = path.join(workDir, 'cache');
  const fixture = await makeFixture(workDir);
  const { server, seen, port } = await serve(fixture.bytes);
  try {
    const progress = [];
    const binary = await ensureFrpcBinary({
      version: VERSION,
      baseUrl: 'http://127.0.0.1:' + port,
      platform: PLATFORM,
      arch: ARCH,
      cacheDir,
      expectedSha256: fixture.good,
      onProgress: (pct) => progress.push(pct),
    });
    assert.equal(binary, path.join(cacheDir, 'bin', 'frp_' + VERSION + '_' + PLATFORM + '_' + ARCH, 'frpc'));
    const stat = await fsp.stat(binary);
    assert.ok((stat.mode & 0o111) !== 0, 'extracted frpc must be executable');
    assert.equal(seen[0], '/v' + VERSION + '/' + ARCHIVE);
    assert.ok(progress.length > 0, 'download progress is reported');
    assert.ok(progress.at(-1) === 100 || progress.at(-1) >= 99, 'progress reaches 100%');

    // A second call is served from cache without touching the network.
    await ensureFrpcBinary({ version: VERSION, baseUrl: 'http://127.0.0.1:' + port, platform: PLATFORM, arch: ARCH, cacheDir, expectedSha256: fixture.good });
    assert.equal(seen.length, 1, 'the cached binary is reused');
  } finally {
    server.close();
  }
});

test('a corrupted download is deleted and rejected', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const cacheDir = path.join(workDir, 'cache');
  const fixture = await makeFixture(workDir, true);
  const { server, port } = await serve(fixture.bytes);
  try {
    await assert.rejects(
      ensureFrpcBinary({
        version: VERSION,
        baseUrl: 'http://127.0.0.1:' + port,
        platform: PLATFORM,
        arch: ARCH,
        cacheDir,
        expectedSha256: fixture.good,
      }),
      (error) => error instanceof ChecksumError,
    );
    const binDir = path.join(cacheDir, 'bin', 'frp_' + VERSION + '_' + PLATFORM + '_' + ARCH);
    await assert.rejects(fsp.stat(path.join(binDir, 'frpc')));
    const leftovers = (await fsp.readdir(cacheDir, { recursive: true })).filter((name) => String(name).includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no partial download is left behind');
  } finally {
    server.close();
  }
});

test('a non-loopback plain-http download base URL is refused', async () => {
  await assert.rejects(
    ensureFrpcBinary({
      version: VERSION,
      baseUrl: 'http://mirror.example.com/frp',
      platform: PLATFORM,
      arch: ARCH,
      cacheDir: path.join(os.tmpdir(), 'test'),
      expectedSha256: 'deadbeef',
    }),
    /https/i,
  );
});

test('an unknown version with no embedded checksum needs explicit consent', async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test'));
  const cacheDir = path.join(workDir, 'cache');
  const fixture = await makeFixture(workDir, false, '9.9.9');
  const { server, port } = await serve(fixture.bytes);
  try {
    await assert.rejects(
      ensureFrpcBinary({ version: '9.9.9', baseUrl: 'http://127.0.0.1:' + port, platform: PLATFORM, arch: ARCH, cacheDir }),
      (error) => error instanceof NoChecksumError,
    );

    const binary = await ensureFrpcBinary({
      version: '9.9.9',
      baseUrl: 'http://127.0.0.1:' + port,
      platform: PLATFORM,
      arch: ARCH,
      cacheDir,
      allowNoChecksum: true,
    });
    assert.ok((await fsp.stat(binary)).size > 0);
  } finally {
    server.close();
  }
});
