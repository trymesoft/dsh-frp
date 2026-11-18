// Host half of dsh-frp.
//
// Wiring only: Config, the credential store, the DSH cookie exchange, the
// gateway, the frpc supervisor, and the panel route the Client half polls.
// The interesting behaviour lives in the modules this file composes.

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { createGateway, loginHtml } from './gateway.js';
import { SessionAuthority, LoginThrottle, constantTimeEqual, randomSecret } from './gateway-session.js';
import { CHECKSUMS, createFrpcManager, ensureFrpcBinary } from './frpc-manager.js';
import { PLUGIN_SCOPES, computeStartGate, createPanelApi, exchangeDshCookie } from './status-routes.js';
import { FRP_VERSION } from './frpc-config.js';

export const name = 'dsh-frp';
export const inject = ['webServer', 'connection', 'webApp', 'subprocess'];

const PANEL_PREFIX = '/dsh-frp';
const ENTRY_ID = 'dsh-frp';
const COOKIE_NAME = 'dsh-frp-session';

/** Loader-row defaults; the Host validates this shape when it loads the row. */
export const Config = {
  enabled: true,
  autoStart: false,
  publicBaseUrl: '',
  frps: {
    serverAddr: '',
    serverPort: 7000,
    domain: '',
    transport: { useTLS: true },
  },
  frpc: {
    binaryPath: '',
    downloadVersion: FRP_VERSION,
    downloadBaseUrl: 'https://github.com/fatedier/frp/releases/download',
  },
  gateway: { sessionTtlHours: 12 },
  login: { username: '' },
};

function dataDirOf() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-frp');
}

function canonicalConfig(config) {
  return {
    enabled: config?.enabled !== false,
    autoStart: Boolean(config?.autoStart),
    publicBaseUrl: String(config?.publicBaseUrl ?? ''),
    frps: {
      serverAddr: String(config?.frps?.serverAddr ?? ''),
      serverPort: Number(config?.frps?.serverPort ?? 7000),
      domain: String(config?.frps?.domain ?? ''),
      transport: { useTLS: config?.frps?.transport?.useTLS !== false },
    },
    frpc: {
      binaryPath: String(config?.frpc?.binaryPath ?? ''),
      downloadVersion: String(config?.frpc?.downloadVersion ?? FRP_VERSION),
      downloadBaseUrl: String(config?.frpc?.downloadBaseUrl ?? Config.frpc.downloadBaseUrl),
    },
    gateway: { sessionTtlHours: Number(config?.gateway?.sessionTtlHours ?? 12) },
    login: { username: String(config?.login?.username ?? '') },
  };
}

/**
 * Secrets live either in the Host credential store or, when that service does
 * not expose a record API, in a 0600 file inside the plugin data directory.
 * Either way they stay out of cordis.patch.yml.
 */
async function createCredentialStore(ctx, dir) {
  const service = (() => {
    try {
      return ctx.get?.('credentials');
    } catch {
      return undefined;
    }
  })();
  const file = path.join(dir, 'credentials.json');
  let cache = null;

  async function loadFile() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      cache = {};
    }
    return cache;
  }

  const usable = Boolean(service && typeof service.readRecord === 'function' && typeof service.modifyRecord === 'function');
  return {
    backend: usable ? 'service' : 'file',
    async read(key) {
      if (usable) {
        try {
          const record = await service.readRecord(key);
          if (typeof record === 'string') return record;
          if (record && typeof record.value === 'string') return record.value;
          if (record && typeof record.secret === 'string') return record.secret;
          return undefined;
        } catch {
          return undefined;
        }
      }
      return (await loadFile())[key];
    },
    async write(key, value) {
      if (usable) {
        await service.modifyRecord(key, value);
        return;
      }
      const current = await loadFile();
      current[key] = value;
      await fsp.writeFile(file, JSON.stringify(current, null, 2), { mode: 0o600 });
      await fsp.chmod(file, 0o600);
    },
  };
}

/** Adapt either a Node readable or an async iterable into a readable stream. */
function asReadable(source) {
  if (!source) return undefined;
  if (typeof source.on === 'function') return source;
  const stream = new PassThrough();
  (async () => {
    try {
      for await (const chunk of source) stream.write(chunk);
      stream.end();
    } catch (error) {
      stream.destroy(error);
    }
  })();
  return stream;
}

function adaptSubprocessHandle(handle) {
  return {
    stdout: asReadable(handle.stdout),
    stderr: asReadable(handle.stderr),
    done: Promise.resolve(handle.done).then(
      (value) => value ?? { exitCode: null },
      () => ({ exitCode: null }),
    ),
    terminate: () => (typeof handle.terminate === 'function' ? handle.terminate() : Promise.resolve()),
  };
}

/**
 * Persist a Config change through the Host's config editor.
 *
 * The editor owns the Loader row, so the panel never writes cordis.patch.yml
 * itself. The call shape is probed once because this Host build exposes it
 * either as edit(id, updater) or edit({ id }, updater).
 */
async function persistConfig(ctx, updater) {
  const service = ctx.get?.('configEditor');
  if (!service || typeof service.edit !== 'function') {
    throw new Error('configEditor service is unavailable: the change applies to this session only, edit the plugin Config to persist it');
  }
  try {
    await service.edit(ENTRY_ID, updater);
    return;
  } catch (first) {
    try {
      await service.edit({ id: ENTRY_ID }, updater);
      return;
    } catch {
      throw first;
    }
  }
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} rawConfig the Loader row's config
 */
export async function apply(ctx, rawConfig) {
  const config = canonicalConfig(rawConfig);
  if (!config.enabled) return;

  const dir = dataDirOf();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const credentials = await createCredentialStore(ctx, dir);

  // Session secret and epoch: both secrets, both outside Config.
  let secret = await credentials.read(PLUGIN_SCOPES.sessionSecret);
  if (!secret) {
    secret = randomSecret(32);
    await credentials.write(PLUGIN_SCOPES.sessionSecret, secret);
  }
  let epoch = Number((await credentials.read(PLUGIN_SCOPES.sessionEpoch)) ?? 0);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    epoch = 1;
    await credentials.write(PLUGIN_SCOPES.sessionEpoch, String(epoch));
  }

  const authority = new SessionAuthority({
    signingSecret: secret,
    epoch: () => epoch,
    ttlHours: config.gateway.sessionTtlHours,
    secure: String(config.publicBaseUrl).startsWith('https://'),
    cookieName: COOKIE_NAME,
  });

  // --- DSH signed cookie --------------------------------------------------
  let dshCookie;
  let exchanging = null;

  async function fetchDshCookie() {
    const advertised = ctx.webApp.getAdvertisedUrl();
    const authenticated = ctx.connection.authenticatedUrl(advertised);
    dshCookie = await exchangeDshCookie({ authenticatedUrl: authenticated, origin: ctx.webServer.getOrigin() });
    return dshCookie;
  }

  function reexchange() {
    if (!exchanging) {
      exchanging = fetchDshCookie().finally(() => {
        exchanging = null;
      });
    }
    return exchanging;
  }

  // --- gateway ------------------------------------------------------------
  const throttle = new LoginThrottle();
  const gateway = createGateway({
    targetOrigin: () => ctx.webServer.getOrigin(),
    dshCookie: () => dshCookie,
    onDshCookie: (cookie) => {
      const pair = String(cookie).split(';')[0].trim();
      const name = pair.slice(0, pair.indexOf('='));
      const rest = String(dshCookie ?? '')
        .split('; ')
        .filter((part) => part.length > 0 && !part.startsWith(name + '='))
        .join('; ');
      dshCookie = rest ? rest + '; ' + pair : pair;
    },
    onAuthInvalid: reexchange,
    authority,
    checkLogin: async (username, password) => {
      const expectedUser = config.login.username;
      const expectedPassword = await credentials.read(PLUGIN_SCOPES.loginPassword);
      if (!expectedUser || !expectedPassword) return false;
      return constantTimeEqual(username, expectedUser) && constantTimeEqual(password, expectedPassword);
    },
    throttle,
    publicDomain: () => config.frps.domain || undefined,
    publicBaseUrl: () => config.publicBaseUrl || 'http://' + (config.frps.domain || 'localhost'),
    loginHtml,
  });

  let gatewayPort = 0;
  try {
    const listened = await gateway.listen();
    gatewayPort = listened.port;
  } catch (error) {
    ctx.logger?.warn?.('dsh-frp: gateway failed to listen: ' + String(error?.message ?? error));
    return;
  }

  // --- frpc supervisor ----------------------------------------------------
  let currentBinary;
  let frpsToken = await credentials.read(PLUGIN_SCOPES.frpsToken);
  const download = { pct: undefined };
  let noChecksumConfirmed = false;

  async function refreshToken() {
    frpsToken = (await credentials.read(PLUGIN_SCOPES.frpsToken)) ?? frpsToken;
    return frpsToken;
  }

  const manager = createFrpcManager({
    spawn: (spec) => adaptSubprocessHandle(ctx.subprocess.spawn(spec)),
    writeToml: async (content) => {
      const tomlPath = path.join(dir, 'frpc.toml');
      await fsp.writeFile(tomlPath, content, { mode: 0o600 });
      await fsp.chmod(tomlPath, 0o600);
      return tomlPath;
    },
    binaryPath: () => currentBinary,
    config: () => ({
      serverAddr: config.frps.serverAddr,
      serverPort: config.frps.serverPort,
      authToken: frpsToken ?? '',
      useTls: config.frps.transport.useTLS,
      domain: config.frps.domain,
    }),
    gatewayPort: () => gatewayPort,
    persistAdminCreds: async (creds) => {
      await credentials.write(PLUGIN_SCOPES.frpcAdmin, JSON.stringify(creds));
    },
    adminPollMs: 1500,
  });

  // A dead gateway must never leave a live tunnel behind: the loopback port
  // could be reused by another service and published without authentication.
  gateway.server.on('error', () => {
    void manager.killImmediately();
  });

  async function ensureBinary() {
    if (config.frpc.binaryPath) {
      await fsp.access(config.frpc.binaryPath);
      currentBinary = config.frpc.binaryPath;
      return currentBinary;
    }
    const cached = path.join(dir, 'bin', 'frp_' + config.frpc.downloadVersion + '_' + process.platform + '_' + process.arch, 'frpc');
    try {
      await fsp.access(cached);
      currentBinary = cached;
      return currentBinary;
    } catch {
      /* not cached yet */
    }
    download.pct = 0;
    try {
      currentBinary = await ensureFrpcBinary({
        version: config.frpc.downloadVersion,
        baseUrl: config.frpc.downloadBaseUrl,
        platform: process.platform,
        arch: process.arch,
        cacheDir: dir,
        allowNoChecksum: noChecksumConfirmed,
        onProgress: (pct) => {
          download.pct = pct;
        },
      });
      return currentBinary;
    } finally {
      download.pct = undefined;
    }
  }

  // --- panel API ----------------------------------------------------------
  const editor = {
    async edit(updater) {
      const next = canonicalConfig(updater(canonicalConfig(config)));
      const before = JSON.stringify(canonicalConfig(config));
      Object.assign(config, next);
      if (JSON.stringify(next) === before) return;
      await persistConfig(ctx, () => next);
    },
  };

  const panelApi = createPanelApi({
    config: () => config,
    credentials,
    editor,
    manager: {
      start: async () => {
        await refreshToken();
        return manager.start();
      },
      stop: () => manager.stop(),
      killImmediately: () => manager.killImmediately(),
      status: () => manager.status(),
      logs: () => manager.logs(),
    },
    gatewayPort: () => gatewayPort,
    ensureBinary,
    binaryPresent: () => currentBinary,
    downloadState: () => download,
    checksumAvailable: (version, platform, arch) => Boolean(CHECKSUMS[version + '_' + platform + '_' + arch]),
    confirmNoChecksum: async () => {
      noChecksumConfirmed = true;
    },
    noChecksumConfirmed: () => noChecksumConfirmed,
    platform: () => ({ platform: process.platform, arch: process.arch }),
  });

  // --- panel route --------------------------------------------------------
  const handler = async (req, res) => {
    const rejection = ctx.connection.requestRejection?.(req);
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain' });
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dsh.invalid');
    const endpointName = url.pathname.slice(PANEL_PREFIX.length).replace(/^\//, '');
    if (!endpointName) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing endpoint' } }));
      return;
    }

    let payload = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
          return;
        }
      }
    }

    try {
      const result = await panelApi.endpoint(endpointName, payload);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result ?? { ok: true }));
    } catch (error) {
      const status = error?.missing ? 409 : 400;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: String(error?.message ?? error), missing: error?.missing ?? [] } }));
    }
  };

  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: PANEL_PREFIX, handler });
  const unsubscribeState = manager.onStateChange(() => {});

  // --- activation ---------------------------------------------------------
  try {
    await fetchDshCookie();
  } catch (error) {
    ctx.logger?.warn?.('dsh-frp: DSH cookie exchange failed at activation: ' + String(error?.message ?? error));
  }

  if (config.autoStart) {
    const gate = computeStartGate(config, {
      loginPassword: await credentials.read(PLUGIN_SCOPES.loginPassword),
      frpsToken,
    });
    if (gate.ok) {
      try {
        await ensureBinary();
        await manager.start();
      } catch (error) {
        ctx.logger?.warn?.('dsh-frp: autoStart failed: ' + String(error?.message ?? error));
      }
    } else {
      ctx.logger?.info?.('dsh-frp: autoStart skipped, missing ' + gate.missing.join(', '));
    }
  }

  ctx.effect(() => {
    return async () => {
      unsubscribeState();
      try {
        await manager.killImmediately();
      } catch {
        /* already gone */
      }
      try {
        if (typeof disposeRoute === 'function') await disposeRoute();
      } catch {
        /* the server may already be gone */
      }
      await gateway.stop();
    };
  });
}
