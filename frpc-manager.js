// frpc binary acquisition and process supervision.
//
// Download path: fetch a pinned frp release, verify the sha256 embedded here,
// extract into the plugin data directory. An unverifiable download is refused
// unless the user explicitly accepted that risk (see status-routes.js).

import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * sha256 of the official frp 0.72.0 release archives, taken from
 * frp_sha256_checksums.txt of that release. Keys are '<version>_<os>_<arch>'.
 */
export const CHECKSUMS = {
  '0.72.0_android_arm64': '096ef4ab7c89ce8893713eaad644fa1b6462ac97d2ae97b5a47890e0780ba3d4',
  '0.72.0_darwin_amd64': '60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9',
  '0.72.0_darwin_arm64': '6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8',
  '0.72.0_freebsd_amd64': '584662abdb72ca01cf01fb9734d99b3bb7183d4cb564dc50b549ee4a46bbf21b',
  '0.72.0_linux_amd64': 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804',
  '0.72.0_linux_arm': 'd0531b20c7fef4c7d2efb281931e62f0612bb7f0de62d200fa9020fd58d319ca',
  '0.72.0_linux_arm64': '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf',
  '0.72.0_linux_arm_hf': '427b4ced2241c621de33405349207f0c5a881586cf014c93b6b698672810741b',
  '0.72.0_linux_loong64': '3b3d14550eeb2f7fd3f07fc181c9c1554fea1f6f93d0a484401957263c30bc9d',
  '0.72.0_linux_mips': '8c000fa9f6abe7e1e6e07566eae8480c45b50a39030576a6000962f4ff408f67',
  '0.72.0_linux_mips64': 'f56bee001293dba5350a9c73fba25a6790be2588da970505a9f70f83168a4e14',
  '0.72.0_linux_mips64le': '60129e503ea0455ac9b7a6761e84774a0a1fca790ecc0bcddf4426f86b25104d',
  '0.72.0_linux_mipsle': 'ef7d44507a65b91545d004507463db0aa5ccaf9e0181ad6bc6535a1924e07263',
  '0.72.0_linux_riscv64': '3c9f6425eb19f85bb063a1ebe9341525f56aa118371a999a993d8c8a27ef59d1',
  '0.72.0_openbsd_amd64': 'e54410709d1d067415cc992c7b5e3d1bf6ad45366a17f11eaa05b610da8aa6ed',
};

export class ChecksumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChecksumError';
  }
}

export class NoChecksumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoChecksumError';
  }
}

/** sha256 of a file, streamed. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/**
 * The download base must be https, except for a loopback mirror (tests and
 * a local relay). Anything else would let a plain-text or hostile origin hand
 * us a binary.
 */
function assertDownloadBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    throw new Error('downloadBaseUrl is not a valid URL: ' + String(baseUrl));
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return;
  throw new Error('downloadBaseUrl must use https (http is allowed only for a loopback mirror)');
}

function archiveName(version, platform, arch) {
  return 'frp_' + version + '_' + platform + '_' + arch + '.tar.gz';
}

function binaryPathOf(cacheDir, version, platform, arch) {
  return path.join(cacheDir, 'bin', 'frp_' + version + '_' + platform + '_' + arch, 'frpc');
}

async function exists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Make an frpc binary available locally and return its absolute path.
 *
 * @param {object} opts
 * @param {string} opts.version      frp version, e.g. '0.72.0'
 * @param {string} opts.baseUrl      release base, e.g. https://github.com/fatedier/frp/releases/download
 * @param {string} opts.platform     process.platform
 * @param {string} opts.arch         process.arch
 * @param {string} opts.cacheDir     plugin data directory
 * @param {string} [opts.expectedSha256] overrides the embedded table
 * @param {boolean} [opts.allowNoChecksum] download even without a known hash
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Promise<string>} absolute path to the executable
 */
export async function ensureFrpcBinary(opts) {
  const { version, baseUrl, platform, arch, cacheDir } = opts;
  assertDownloadBaseUrl(baseUrl);

  const target = binaryPathOf(cacheDir, version, platform, arch);
  if (await exists(target)) return target;

  const key = version + '_' + platform + '_' + arch;
  const expected = opts.expectedSha256 ?? CHECKSUMS[key];
  if (!expected && !opts.allowNoChecksum) {
    throw new NoChecksumError(
      'No embedded sha256 for frp ' + version + ' on ' + platform + '/' + arch + '; confirm the unverified risk in the panel first',
    );
  }
  if (platform === 'win32') throw new Error('Windows archives are not supported by the extractor');

  const url = String(baseUrl).replace(/\/+$/, '') + '/v' + version + '/' + archiveName(version, platform, arch);
  const binRoot = path.join(cacheDir, 'bin');
  await fsp.mkdir(binRoot, { recursive: true });
  const tmp = path.join(binRoot, '.tmp-' + process.pid + '-' + Date.now());

  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error('download failed: HTTP ' + response.status + ' from ' + url);
    }
    const total = Number(response.headers.get('content-length') ?? 0);
    let received = 0;
    const handle = await fsp.open(tmp, 'w');
    try {
      for await (const chunk of response.body) {
        await handle.write(chunk);
        received += chunk.length;
        if (total > 0 && opts.onProgress) opts.onProgress(Math.min(99, Math.floor((received / total) * 100)));
      }
    } finally {
      await handle.close();
    }

    if (expected) {
      const actual = await sha256File(tmp);
      if (actual !== expected) {
        throw new ChecksumError('sha256 mismatch for ' + archiveName(version, platform, arch) + ': expected ' + expected + ', got ' + actual);
      }
    }

    await execFileAsync('tar', ['-xzf', tmp, '-C', binRoot]);
    const fresh = binaryPathOf(cacheDir, version, platform, arch);
    if (!(await exists(fresh))) throw new Error('archive did not contain ' + path.relative(binRoot, fresh));
    await fsp.chmod(fresh, 0o755);
    if (opts.onProgress) opts.onProgress(100);
    return fresh;
  } catch (error) {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      /* best effort */
    }
    if (error instanceof ChecksumError || error instanceof NoChecksumError) throw error;
    throw error;
  } finally {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}
