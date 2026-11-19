// The panel's control surface, plus the two helpers the Host wiring needs:
// the start gate and the DSH cookie exchange.
//
// Everything here is plain functions over injected dependencies, so the whole
// panel protocol is testable without a Host, a GUI, or a network.

import { constantTimeEqual } from './gateway-session.js';

/** Credentials records owned by this plugin. Secrets never enter Config. */
export const PLUGIN_SCOPES = {
  frpsToken: 'dsh-frp/frps-token',
  loginPassword: 'dsh-frp/login-password',
  sessionSecret: 'dsh-frp/session-secret',
  sessionEpoch: 'dsh-frp/session-epoch',
  frpcAdmin: 'dsh-frp/frpc-admin',
};

const MIN_PASSWORD_LENGTH = 12;

/**
 * Everything that must be true before a tunnel may start (spec §5.2 hard gate).
 *
 * @param {object} config plugin Config
 * @param {{loginPassword?: string, frpsToken?: string}} credentials
 * @returns {{ok: boolean, missing: string[]}}
 */
export function computeStartGate(config, credentials) {
  const missing = [];
  const username = String(config?.login?.username ?? '').trim();
  if (!username) missing.push('login-username');
  if (!String(credentials?.loginPassword ?? '').trim()) missing.push('login-password');
  if (!String(config?.frps?.serverAddr ?? '').trim()) missing.push('frps-server-addr');
  if (!String(config?.frps?.domain ?? '').trim()) missing.push('frps-domain');
  if (!String(config?.publicBaseUrl ?? '').trim()) missing.push('public-base-url');
  if (!String(credentials?.frpsToken ?? '').trim()) missing.push('frps-token');
  return { ok: missing.length === 0, missing };
}

/**
 * Trade the launch-token URL for the DSH signed cookie.
 *
 * The GUI mints the cookie on GET / with exactly one token query parameter and
 * answers 303; we keep only "name=value" pairs, joined for later injection.
 *
 * @param {{authenticatedUrl: string, origin: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<string>}
 */
export async function exchangeDshCookie(opts) {
  const doFetch = opts.fetchImpl ?? fetch;
  // The launch token must be presented on the GUI's own origin: the cookie we
  // receive is scoped to the request's authority, and every proxied request
  // later carries Host: origin. Minting on an advertised (public) URL would
  // hand us a cookie the GUI never accepts.
  let url = opts.authenticatedUrl;
  const token = new URL(opts.authenticatedUrl).searchParams.get('token');
  if (token && opts.origin) {
    url = new URL(opts.origin).origin + '/?token=' + encodeURIComponent(token);
  }
  const response = await doFetch(url, { redirect: 'manual' });
  if (response.status !== 303) {
    throw new Error('DSH cookie exchange expected 303, got ' + response.status);
  }
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  const pairs = setCookies.map((entry) => String(entry).split(';')[0].trim()).filter(Boolean);
  if (pairs.length === 0) {
    throw new Error('DSH cookie exchange returned no cookie');
  }
  return pairs.join('; ');
}

/**
 * A panel-facing rejection: `code` lets the panel localize the reason instead
 * of showing the Host's English sentence, `details` carries the field or list
 * the panel needs to point at.
 */
function invalid(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw invalid('empty-field', label + ' must not be empty', { field: label });
  if (/[\r\n]/.test(text)) throw invalid('invalid-text', label + ' must not contain a newline', { field: label });
  return text;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function requireDomain(value, label) {
  const text = requireText(value, label);
  if (!DOMAIN_RE.test(text)) throw invalid('invalid-domain', label + ' must be a plain domain name', { field: label, value: text });
  return text.toLowerCase();
}

function requirePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('invalid-port', label + ' must be an integer TCP port', { field: label, value });
  return port;
}

function requirePublicUrl(value) {
  const text = requireText(value, 'public base URL');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw invalid('invalid-url', 'public base URL is not a valid URL', { field: 'publicBaseUrl', value: text });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('invalid-url', 'public base URL must use http or https', { field: 'publicBaseUrl', value: text });
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw invalid('invalid-url', 'public base URL must be an origin without a path', { field: 'publicBaseUrl', value: text });
  }
  return parsed.origin;
}

/**
 * The panel API: one entry point, one endpoint per action.
 *
 * @param {object} deps
 * @param {() => object} deps.config            current Config
 * @param {{read: (key: string) => Promise<string | undefined>, write: (key: string, value: string) => Promise<void>}} deps.credentials
 * @param {{edit: (updater: (config: object) => object) => Promise<void>}} deps.editor
 * @param {object} deps.manager                 frpc manager
 * @param {() => number} deps.gatewayPort
 * @param {() => Promise<string>} deps.ensureBinary
 * @param {() => string | undefined} deps.binaryPresent
 * @param {() => {pct?: number}} deps.downloadState
 * @param {(version: string, platform: string, arch: string) => boolean} deps.checksumAvailable
 * @param {() => {platform: string, arch: string}} deps.platform
 */
export function createPanelApi(deps) {
  async function credentialSnapshot() {
    const [loginPassword, frpsToken] = await Promise.all([
      deps.credentials.read(PLUGIN_SCOPES.loginPassword),
      deps.credentials.read(PLUGIN_SCOPES.frpsToken),
    ]);
    return { loginPassword, frpsToken };
  }

  async function readEpoch() {
    const raw = await deps.credentials.read(PLUGIN_SCOPES.sessionEpoch);
    const value = Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  async function status() {
    const config = deps.config();
    const credentials = await credentialSnapshot();
    const gate = computeStartGate(config, credentials);
    const gateway = (deps.gatewayState?.() ?? { ok: true });
    const binary = deps.binaryPresent();
    const download = deps.downloadState();
    const managerStatus = deps.manager.status();

    // `reason` is what the panel renders (it owns the language); `message` is
    // the Host's diagnostic sentence and stays untranslated on purpose.
    let state;
    let message = managerStatus.message;
    let reason = managerStatus.reason;
    if (!gate.ok) {
      state = 'not-configured';
      message = undefined;
      reason = { code: 'not-configured', params: { missing: gate.missing } };
    } else if (!binary) {
      state = download.pct !== undefined ? 'downloading' : 'need-binary';
      message = undefined;
      reason = download.pct !== undefined ? { code: 'downloading', params: { pct: download.pct } } : { code: 'need-binary' };
    } else {
      state = managerStatus.state;
    }

    return {
      state,
      message,
      reason,
      missing: gate.missing,
      publicUrl: String(config?.publicBaseUrl ?? ''),
      domain: String(config?.frps?.domain ?? ''),
      serverAddr: String(config?.frps?.serverAddr ?? ''),
      serverPort: config?.frps?.serverPort,
      useTls: Boolean(config?.frps?.transport?.useTLS),
      username: String(config?.login?.username ?? ''),
      hasFrpsToken: Boolean(credentials.frpsToken),
      hasLoginPassword: Boolean(credentials.loginPassword),
      binaryMode: config?.frpc?.binaryPath ? 'path' : 'download',
      // `binaryPath` is the binary in use, which in download mode is a cache
      // path; the form must seed from the configured value, or "use a local
      // path" would offer the cache path as if the user had typed it.
      binaryPath: binary,
      configuredBinaryPath: String(config?.frpc?.binaryPath ?? ''),
      downloadVersion: String(config?.frpc?.downloadVersion ?? ''),
      downloadPct: download.pct,
      checksumAvailable: (() => {
        const { platform, arch } = deps.platform();
        return deps.checksumAvailable(String(config?.frpc?.downloadVersion ?? ''), platform, arch);
      })(),
      proxyState: managerStatus.proxyState,
      gateway: gateway.ok ? 'ok' : 'error',
      gatewayMessage: gateway.message,
      gatewayPort: deps.gatewayPort(),
      autoStart: Boolean(config?.autoStart),
      logsTail: deps.manager.logs().slice(-40),
    };
  }

  async function start() {
    const config = deps.config();
    const credentials = await credentialSnapshot();
    const gate = computeStartGate(config, credentials);
    if (!gate.ok) {
      const error = new Error('Cannot start: missing ' + gate.missing.join(', '));
      error.code = 'start-gate';
      error.missing = gate.missing;
      error.details = { missing: gate.missing };
      throw error;
    }
    await deps.ensureBinary(false);
    await deps.manager.start();
    return status();
  }

  /**
   * Download the frpc binary now, rather than waiting for the next start.
   *
   * A version without an embedded checksum raises NoChecksumError; the panel
   * turns that into an explicit consent prompt and calls again with
   * allowNoChecksum, so the documented "warn, then continue" path exists.
   */
  async function download(payload) {
    try {
      await deps.ensureBinary(Boolean(payload?.allowNoChecksum));
    } catch (error) {
      if (error && error.name === 'NoChecksumError') {
        const failure = new Error(String(error.message));
        failure.code = 'no-checksum';
        throw failure;
      }
      throw error;
    }
    return status();
  }

  async function setLogin(payload) {
    const username = requireText(payload?.username, 'username');
    const password = String(payload?.password ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw invalid('password-too-short', 'password must be at least ' + MIN_PASSWORD_LENGTH + ' characters', { min: MIN_PASSWORD_LENGTH });
    }
    if (/[\r\n]/.test(password)) throw invalid('invalid-text', 'password must not contain a newline', { field: 'password' });

    const current = deps.config();
    if (String(current?.login?.username ?? '') !== username) {
      await deps.editor.edit((config) => ({ ...config, login: { ...(config.login ?? {}), username } }));
    }
    if (!constantTimeEqual(String((await deps.credentials.read(PLUGIN_SCOPES.loginPassword)) ?? ''), password)) {
      await deps.credentials.write(PLUGIN_SCOPES.loginPassword, password);
      // A password change must sign every device out. The Host passes a hook
      // that bumps the live epoch the running SessionAuthority reads, and
      // persists it; without the hook (bare tests) bump the record only.
      if (typeof deps.bumpEpoch === 'function') {
        await deps.bumpEpoch();
      } else {
        await deps.credentials.write(PLUGIN_SCOPES.sessionEpoch, String((await readEpoch()) + 1));
      }
    }
    return { ok: true, restartRequired: false };
  }

  async function setFrpsToken(payload) {
    const token = requireText(payload?.token, 'frps token');
    await deps.credentials.write(PLUGIN_SCOPES.frpsToken, token);
    return { ok: true };
  }

  async function setFrpsConfig(payload) {
    const patch = {};
    if (payload?.serverAddr !== undefined) patch.serverAddr = requireText(payload.serverAddr, 'serverAddr');
    if (payload?.serverPort !== undefined) patch.serverPort = requirePort(payload.serverPort, 'serverPort');
    if (payload?.domain !== undefined) patch.domain = requireDomain(payload.domain, 'domain');
    if (payload?.useTLS !== undefined) patch.useTLS = Boolean(payload.useTLS);
    const publicBaseUrl = payload?.publicBaseUrl !== undefined ? requirePublicUrl(payload.publicBaseUrl) : undefined;

    await deps.editor.edit((config) => {
      const next = {
        ...config,
        frps: {
          ...(config.frps ?? {}),
          ...(patch.serverAddr !== undefined ? { serverAddr: patch.serverAddr } : {}),
          ...(patch.serverPort !== undefined ? { serverPort: patch.serverPort } : {}),
          ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
          transport: {
            ...(config.frps?.transport ?? {}),
            ...(patch.useTLS !== undefined ? { useTLS: patch.useTLS } : {}),
          },
        },
      };
      if (publicBaseUrl !== undefined) next.publicBaseUrl = publicBaseUrl;
      return next;
    });
    return { restartRequired: true };
  }

  async function chooseBinary(payload) {
    const mode = payload?.mode;
    if (mode === 'path') {
      const binaryPath = requireText(payload?.path, 'binary path');
      await deps.editor.edit((config) => ({ ...config, frpc: { ...(config.frpc ?? {}), binaryPath } }));
      return { restartRequired: true };
    }
    if (mode === 'download') {
      await deps.editor.edit((config) => ({ ...config, frpc: { ...(config.frpc ?? {}), binaryPath: '' } }));
      return { restartRequired: true };
    }
    throw invalid('invalid-mode', 'chooseBinary mode must be "path" or "download"', { value: String(mode) });
  }

  const handlers = {
    status,
    start,
    stop: async () => {
      await deps.manager.stop();
      return status();
    },
    getLogs: async () => ({ lines: deps.manager.logs() }),
    setLogin,
    setFrpsToken,
    setFrpsConfig,
    chooseBinary,
    download,
  };

  return {
    async endpoint(name, payload) {
      const handler = handlers[name];
      if (!handler) throw new Error('unknown endpoint: ' + String(name));
      return handler(payload ?? {});
    },
  };
}
