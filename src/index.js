// Host half of dsh-frp.
//
// Wiring only: Config, the credential store, the DSH cookie exchange, the
// gateway, the frpc supervisor, and the panel route the Client half polls.
// The interesting behaviour lives in the modules this file composes.

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PassThrough } from 'node:stream';

import { createGateway, loginHtml } from './gateway.js';
import { SessionAuthority, LoginThrottle, constantTimeEqual, randomSecret } from './gateway-session.js';
import { CHECKSUMS, createFrpcManager, ensureFrpcBinary } from './frpc-manager.js';
import { PLUGIN_SCOPES, computeStartGate, createPanelApi, exchangeDshCookie } from './status-routes.js';
import { FRP_VERSION } from './frpc-config.js';

export const name = 'dsh-frp';
export const inject = ['webServer', 'connection', 'webApp', 'subprocess'];

const PANEL_PREFIX = '/dsh-frp';
const COOKIE_NAME = 'dsh_frp_session';

/** Loader-row defaults, used for documentation and for canonicalConfig's fallbacks. */
const CONFIG_DEFAULTS = {
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

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function configIssues(raw) {
  const issues = [];
  const value = raw ?? {};
  const text = (candidate) => (candidate === undefined || candidate === null ? '' : String(candidate));

  const publicBaseUrl = text(value.publicBaseUrl).trim();
  if (publicBaseUrl) {
    let parsed;
    try {
      parsed = new URL(publicBaseUrl);
    } catch {
      issues.push({ message: 'publicBaseUrl must be a valid URL', path: ['publicBaseUrl'] });
    }
    if (parsed && !['http:', 'https:'].includes(parsed.protocol)) {
      issues.push({ message: 'publicBaseUrl must use http or https', path: ['publicBaseUrl'] });
    }
    if (parsed && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
      issues.push({ message: 'publicBaseUrl must be an origin without path, query or hash', path: ['publicBaseUrl'] });
    }
  }

  const port = value.frps?.serverPort;
  if (port !== undefined && port !== null && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    issues.push({ message: 'frps.serverPort must be an integer TCP port', path: ['frps', 'serverPort'] });
  }

  const domain = text(value.frps?.domain).trim();
  if (domain && !DOMAIN_RE.test(domain)) {
    issues.push({ message: 'frps.domain must be a plain domain name', path: ['frps', 'domain'] });
  }

  const newlineChecks = [
    ['frps.serverAddr', text(value.frps?.serverAddr)],
    ['login.username', text(value.login?.username)],
    ['frpc.binaryPath', text(value.frpc?.binaryPath)],
    ['frpc.downloadVersion', text(value.frpc?.downloadVersion)],
    ['frpc.downloadBaseUrl', text(value.frpc?.downloadBaseUrl)],
  ];
  for (const [key, candidate] of newlineChecks) {
    if (/[\r\n]/.test(candidate)) issues.push({ message: key + ' must not contain a newline', path: key.split('.') });
  }

  const baseUrl = text(value.frpc?.downloadBaseUrl).trim();
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      issues.push({ message: 'frpc.downloadBaseUrl must be a valid URL', path: ['frpc', 'downloadBaseUrl'] });
    }
    if (parsed) {
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        issues.push({ message: 'frpc.downloadBaseUrl must use https (http only for a loopback mirror)', path: ['frpc', 'downloadBaseUrl'] });
      }
    }
  }

  const ttl = value.gateway?.sessionTtlHours;
  if (ttl !== undefined && ttl !== null && (!Number.isFinite(Number(ttl)) || Number(ttl) <= 0)) {
    issues.push({ message: 'gateway.sessionTtlHours must be a positive number', path: ['gateway', 'sessionTtlHours'] });
  }

  return issues;
}

/**
 * Loader-row schema.
 *
 * cordis resolves a plugin's config through the Standard Schema interface
 * (Config['~standard'].validate(raw)). A bare defaults object is not that
 * interface, and cordis then throws "Cannot read properties of undefined
 * (reading 'validate')" while mounting the row.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-frp',
    validate(raw) {
      const issues = configIssues(raw);
      if (issues.length > 0) return { issues };
      return { value: canonicalConfig(raw ?? CONFIG_DEFAULTS) };
    },
  },
};

function dataDirOf() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-frp');
}

/**
 * Normalize the public entrance to a bare origin.
 *
 * The URL parser lowercases the scheme and host and drops a default port, so
 * `HTTPS://Dsh.Example.com/` and `https://dsh.example.com` behave identically —
 * in particular for the `Secure` / `__Host-` decision below.
 */
function normalizePublicBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    return new URL(text).origin;
  } catch {
    return text;
  }
}

function canonicalConfig(config) {
  return {
    enabled: config?.enabled !== false,
    // Fail closed, unlike its neighbours: a quoted "false" in cordis.patch.yml
    // is a plausible hand-edit typo, and Boolean() would read it as true and
    // open the public entrance at every boot. The endpoint refuses that same
    // coercion, so the load path must not quietly accept it.
    autoStart: config?.autoStart === true,
    publicBaseUrl: normalizePublicBaseUrl(config?.publicBaseUrl),
    frps: {
      serverAddr: String(config?.frps?.serverAddr ?? ''),
      serverPort: Number(config?.frps?.serverPort ?? 7000),
      domain: String(config?.frps?.domain ?? ''),
      transport: { useTLS: config?.frps?.transport?.useTLS !== false },
    },
    frpc: {
      binaryPath: String(config?.frpc?.binaryPath ?? ''),
      downloadVersion: String(config?.frpc?.downloadVersion ?? FRP_VERSION),
      downloadBaseUrl: String(config?.frpc?.downloadBaseUrl ?? CONFIG_DEFAULTS.frpc.downloadBaseUrl),
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
          // A record is either an api-key or an owner-defined grant; our
          // secrets ride in the opaque grant payload, as the seam intends.
          const record = await service.readRecord(key);
          if (!record) return undefined;
          if (record.kind === 'grant') {
            const payload = record.payload;
            if (typeof payload === 'string') return payload;
            if (payload && typeof payload.value === 'string') return payload.value;
            return undefined;
          }
          if (record.kind === 'api-key' && typeof record.key === 'string') return record.key;
          return undefined;
        } catch {
          return undefined;
        }
      }
      return (await loadFile())[key];
    },
    async write(key, value) {
      if (usable) {
        // The record API takes a mutator because a correct write may depend on
        // the current value (read-decide-replace under one lock).
        await service.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { value: String(value) } }));
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
 * itself. `ConfigEditor.edit()` takes the Loader *entry*, the identity it
 * validates, reconciles and restarts: a row id (or `{ id }`) is not an entry
 * and is refused with "Configuration entry is no longer available", which
 * used to leave every panel save unpersisted.
 *
 * @param {object} ctx Cordis context
 * @param {(current: object, inherited: object) => object} change complete next config
 */
async function persistConfig(ctx, change) {
  const service = ctx.get?.('configEditor');
  const entry = ctx.fiber?.entry;
  if (!service || typeof service.edit !== 'function' || entry === undefined) {
    throw new Error('This profile cannot save plugin configuration: its config editor is unavailable, so edit the plugin Config directly');
  }
  await service.edit(entry, change);
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
    secure: config.publicBaseUrl.startsWith('https://'),
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
      // Both comparisons run before the result is combined: a wrong username
      // must not short-circuit the password comparison.
      const userOk = constantTimeEqual(username, expectedUser);
      const passwordOk = constantTimeEqual(password, expectedPassword);
      return userOk && passwordOk;
    },
    throttle,
    publicDomain: () => config.frps.domain || undefined,
    publicBaseUrl: () => config.publicBaseUrl || 'http://' + (config.frps.domain || 'localhost'),
    loginHtml,
  });

  let gatewayPort = 0;
  let gatewayError;
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
  gateway.server.on('error', (error) => {
    gatewayError = String(error?.message ?? error);
    void manager.killImmediately();
  });

  /** Where a downloaded frpc for the configured version would live. */
  function cachedBinaryPath() {
    return path.join(dir, 'bin', 'frp_' + config.frpc.downloadVersion + '_' + process.platform + '_' + process.arch, 'frpc');
  }

  async function ensureBinary(allowNoChecksum = false) {
    if (config.frpc.binaryPath) {
      await fsp.access(config.frpc.binaryPath);
      currentBinary = config.frpc.binaryPath;
      return currentBinary;
    }
    const cached = cachedBinaryPath();
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
        allowNoChecksum: Boolean(allowNoChecksum),
        onProgress: (pct) => {
          download.pct = pct;
        },
      });
      return currentBinary;
    } finally {
      download.pct = undefined;
    }
  }

  /**
   * Resolve the binary already on disk without downloading anything.
   *
   * Without this, every reload reports "frpc missing" until someone starts the
   * tunnel, and the panel's next-step advice tells the user to fetch a binary
   * that is already cached.
   */
  async function detectBinary() {
    const candidate = config.frpc.binaryPath || cachedBinaryPath();
    try {
      await fsp.access(candidate);
      currentBinary = candidate;
    } catch {
      currentBinary = undefined;
    }
  }

  await detectBinary();

  // --- panel API ----------------------------------------------------------
  // A panel edit is persisted first and applied second: the config editor
  // restarts this entry, so the value on disk is the one the next `apply`
  // reads. Mutating the live config first would show unsaved values in the
  // panel and silently drop them on the next reload.
  const editor = {
    async edit(updater) {
      // Saving the values that are already live must not restart the plugin:
      // the reload drops the tunnel, and a no-op save is the commonest thing a
      // user does while checking the form.
      const before = canonicalConfig(config);
      let next = canonicalConfig(updater(before));
      if (isDeepStrictEqual(next, before)) return;
      await persistConfig(ctx, (current) => {
        next = canonicalConfig(updater(canonicalConfig(current)));
        return next;
      });
      Object.assign(config, next);
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
    bumpEpoch: async () => {
      epoch += 1;
      await credentials.write(PLUGIN_SCOPES.sessionEpoch, String(epoch));
    },
    gatewayState: () => (gatewayError ? { ok: false, message: gatewayError } : { ok: true }),
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
    const pathEndpoint = url.pathname.slice(PANEL_PREFIX.length).replace(/^\//, '');

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
          return;
        }
      }
    }

    // The GUI's rpc.call speaks an envelope: {type:'client-request', rpcId,
    // method, payload} in, {type:'server-response', rpcId, result} out. A bare
    // JSON request/response is still accepted for curl and the tests.
    const isEnvelope = body?.type === 'client-request' && typeof body.rpcId === 'string' && typeof body.method === 'string';
    const endpointName = isEnvelope ? body.method : pathEndpoint;
    const payload = isEnvelope ? (body.payload ?? {}) : body;

    // An application failure still travels as a successful HTTP exchange: the
    // GUI's rpc client throws on any non-2xx before reading the envelope, so a
    // 400 here would hide the Host's error code behind "transport failure" and
    // the panel could not say why a save was refused. Bare JSON callers (curl,
    // the tests) keep the meaningful status instead.
    const respond = (status, result, error) => {
      res.writeHead(isEnvelope ? 200 : status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (isEnvelope) {
        const envelopeOut = error
          ? { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error } }
          : { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: result ?? { ok: true } } };
        res.end(JSON.stringify(envelopeOut));
        return;
      }
      res.end(JSON.stringify(error ? { error } : (result ?? { ok: true })));
    };

    if (!endpointName) {
      respond(404, undefined, { code: 'missing-endpoint', message: 'missing endpoint', details: {} });
      return;
    }

    try {
      const result = await panelApi.endpoint(endpointName, payload);
      respond(200, result);
    } catch (error) {
      const missing = error?.missing ?? [];
      const code = error?.code ?? (missing.length ? 'start-gate' : 'request-failed');
      const details = missing.length ? { missing } : (error?.details ?? {});
      respond(missing.length ? 409 : 400, undefined, {
        code: String(code),
        message: String(error?.message ?? error),
        details,
      });
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
