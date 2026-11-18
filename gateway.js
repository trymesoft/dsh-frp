// The authenticated public gateway.
//
// It listens on loopback only and does three things:
//   1. serve a login page and a signed session cookie of its own (the DSH
//      signed cookie is never handed to a browser),
//   2. rewrite a visitor's request into what the DSH GUI's request fence
//      accepts (see header-rules.js), injecting the DSH cookie it holds,
//   3. pipe the answer back with Set-Cookie always stripped and Location
//      rewritten to the public base URL.
//
// frpc points at this port; nothing else should be exposed.

import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import {
  clientIpFromXff,
  hasFramingConflict,
  normalizeRequestHeaders,
  parseRequestTarget,
  rewriteResponseHeaders,
} from './header-rules.js';

const PUBLIC_BASE_FALLBACK = 'https://localhost';

export const LOGIN_PATH = '/frp-login';
const MAX_LOGIN_BODY = 8 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The login page: self-contained, no external resources, no cache. */
export function loginHtml(error) {
  const errorBlock = error
    ? '<p class="error" data-login-error role="alert">' + escapeHtml(error) + '</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · DSH</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --text:#e8ebf0; --muted:#98a2b3; --accent:#4c8dff; --danger:#ff6b6b; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6f8; --panel:#ffffff; --line:#e3e6ec; --text:#12161c; --muted:#5b6472; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", sans-serif; padding:24px; }
  .card { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { margin:0 0 4px; font-size:19px; font-weight:600; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; border-radius:9px; border:1px solid var(--line); background:transparent; color:var(--text); font-size:15px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  button { width:100%; margin-top:20px; padding:11px 12px; border-radius:9px; border:0; background:var(--accent); color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:active { transform: translateY(1px); }
  .error { margin:0 0 4px; padding:9px 11px; border-radius:9px; border:1px solid var(--danger); color:var(--danger); font-size:13px; }
  .note { margin:18px 0 0; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
  <main class="card">
    <h1>DSH</h1>
    <p class="sub">This entrance controls the machine that hosts it.</p>
    ${errorBlock}
    <form method="post" action="${LOGIN_PATH}" autocomplete="on">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocapitalize="none" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    <p class="note">Sessions expire automatically. Change the password in the DSH panel to sign every device out.</p>
  </main>
</body>
</html>
`;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function canonicalHost(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? raw : raw.slice(1, end);
  }
  const colon = raw.lastIndexOf(':');
  const host = colon === -1 ? raw : raw.slice(0, colon);
  return host.replace(/\.$/, '');
}

function sendHtml(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function badGatewayPage(reason) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>502 Bad Gateway</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 -apple-system,sans-serif;padding:24px}
main{max-width:420px}h1{font-size:18px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>502 Bad Gateway</h1><p>The DSH instance behind this entrance is not answering. ${escapeHtml(reason)}</p></main></body></html>`;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Build the gateway.
 *
 * @param {object} opts
 * @param {() => string} opts.targetOrigin      the GUI origin, read per request
 * @param {() => string | undefined} opts.dshCookie  the DSH signed cookie value
 * @param {(cookie: string) => void} opts.onDshCookie  harvest a rotated upstream cookie
 * @param {() => Promise<void>} opts.onAuthInvalid  re-exchange after an upstream 401
 * @param {import('./gateway-session.js').SessionAuthority} opts.authority
 * @param {(username: string, password: string) => Promise<boolean>} opts.checkLogin
 * @param {import('./gateway-session.js').LoginThrottle} opts.throttle
 * @param {() => string | undefined} opts.publicDomain  the vhost domain frps routes
 * @param {() => string} [opts.publicBaseUrl]     the public entrance, for Location rewrites
 * @param {string} [opts.loginTitle]
 * @param {http.Agent} [opts.keepAliveAgent]
 */
export function createGateway(opts) {
  const agent = opts.keepAliveAgent ?? new http.Agent({ keepAlive: true });
  const loginPageOf = opts.loginHtml ?? loginHtml;
  let port = 0;

  function publicBaseUrl() {
    if (opts.publicBaseUrl) return opts.publicBaseUrl();
    const domain = opts.publicDomain?.() ?? canonicalHost('localhost');
    return 'https://' + domain;
  }

  function hostAllowed(hostHeader) {
    const raw = String(hostHeader ?? '').trim().toLowerCase();
    // Local traffic must address the gateway itself.
    if (raw === '127.0.0.1:' + port || raw === 'localhost:' + port) return true;
    // Public traffic must address the vhost domain frps routes to us. Anything
    // else (a scanner hitting the port directly, a misconfigured nginx) is
    // refused here rather than trusted to the next hop.
    const domain = opts.publicDomain?.();
    if (!domain) return false;
    return canonicalHost(raw) === canonicalHost(domain);
  }

  function sessionOf(req) {
    const cookies = parseCookies(req.headers.cookie);
    const value = cookies[opts.authority.name()];
    if (!value) return undefined;
    return opts.authority.verify(value) ? value : undefined;
  }

  function redirectToLogin(res) {
    res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
  }

  async function handleLogin(req, res) {
    opts.throttle.tick();
    const delay = opts.throttle.currentDelay();
    if (delay > 0) await sleep(delay);

    let fields;
    try {
      fields = new URLSearchParams(await readBody(req, MAX_LOGIN_BODY));
    } catch {
      opts.throttle.noteFailure();
      res.writeHead(302, { location: '/?e=1', 'cache-control': 'no-store', 'content-length': 0 });
      res.end();
      return;
    }
    const username = fields.get('username') ?? '';
    const password = fields.get('password') ?? '';

    let ok = false;
    try {
      ok = await opts.checkLogin(username, password);
    } catch {
      ok = false;
    }
    if (!ok) {
      opts.throttle.noteFailure();
      res.writeHead(302, { location: '/?e=1', 'cache-control': 'no-store', 'content-length': 0 });
      res.end();
      return;
    }

    const value = opts.authority.issue();
    res.writeHead(302, {
      location: '/',
      'set-cookie': opts.authority.sessionCookieString(value),
      'cache-control': 'no-store',
      'content-length': 0,
    });
    res.end();
  }

  function proxyHttp(req, res, path, attempt) {
    let target;
    try {
      target = new URL(opts.targetOrigin());
    } catch {
      sendHtml(res, 502, badGatewayPage('The gateway could not resolve the GUI address.'));
      return;
    }
    const clientIp = clientIpFromXff(req.headers['x-forwarded-for']);
    const headers = normalizeRequestHeaders(req.headers, { targetAuthority: target.host, clientIp });
    const cookie = opts.dshCookie();
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    const upstreamReq = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path,
      headers,
      agent,
    });

    upstreamReq.on('response', (upstreamRes) => {
      const { headers: outHeaders, harvestedCookies } = rewriteResponseHeaders(upstreamRes.headers, {
        publicBaseUrl: publicBaseUrl(),
      });
      for (const harvested of harvestedCookies) opts.onDshCookie(harvested);

      const canRetry = attempt === 0 && !(req.headers['content-length'] && req.headers['content-length'] !== '0') && !req.headers['transfer-encoding'];
      if (upstreamRes.statusCode === 401 && canRetry) {
        upstreamRes.resume();
        upstreamRes.on('end', () => {
          Promise.resolve(opts.onAuthInvalid())
            .then(() => proxyHttp(req, res, path, attempt + 1))
            .catch(() => sendHtml(res, 502, badGatewayPage('The gateway could not refresh its DSH session.')));
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });

    upstreamReq.on('error', () => {
      if (!res.headersSent) sendHtml(res, 502, badGatewayPage('The DSH instance did not answer.'));
      else res.destroy();
    });

    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  function handleRequest(req, res) {
    if (!hostAllowed(req.headers.host)) {
      sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><h1>404 Not Found</h1>');
      return;
    }

    const path = parseRequestTarget(req.url);
    const query = new URL(path, 'http://gateway.invalid');
    const session = sessionOf(req);

    if (req.method === 'GET' && query.pathname === '/') {
      if (!session) {
        const error = query.searchParams.has('e') ? 'Wrong username or password.' : undefined;
        sendHtml(res, 200, loginPageOf(error));
        return;
      }
    }

    if (req.method === 'POST' && query.pathname === LOGIN_PATH) {
      handleLogin(req, res).catch(() => {
        if (!res.headersSent) sendHtml(res, 500, '<!doctype html><meta charset="utf-8"><h1>500</h1>');
        else res.destroy();
      });
      return;
    }

    if (!session) {
      redirectToLogin(res);
      return;
    }

    if (hasFramingConflict(req.headers)) {
      sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><title>400</title><h1>400 Bad Request</h1>');
      return;
    }

    proxyHttp(req, res, path, 0);
  }

  function refuseUpgrade(socket, status, reason) {
    socket.write('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }

  function handleUpgrade(req, socket, head) {
    if (!hostAllowed(req.headers.host)) {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!sessionOf(req)) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    let target;
    try {
      target = new URL(opts.targetOrigin());
    } catch {
      refuseUpgrade(socket, 502, 'Bad Gateway');
      return;
    }

    const clientIp = clientIpFromXff(req.headers['x-forwarded-for']);
    const headers = normalizeRequestHeaders(req.headers, { targetAuthority: target.host, clientIp });
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const cookie = opts.dshCookie();
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    relayUpgrade(headers, req, socket, head, 0);
  }

  /**
   * Relay one WebSocket upgrade, filtering whatever the upstream answers.
   *
   * A 101 is byte-transparent from that point on, as a WebSocket pipe must be.
   * Anything else is a plain HTTP answer travelling a WebSocket-shaped request:
   * it goes through the same header rules as every other response (no
   * Set-Cookie may escape, Location is rewritten), and a 401 triggers exactly
   * one DSH cookie re-exchange before a retry.
   */
  function relayUpgrade(headers, req, socket, head, attempt) {
    let target;
    try {
      target = new URL(opts.targetOrigin());
    } catch {
      refuseUpgrade(socket, 502, 'Bad Gateway');
      return;
    }

    const upstream = net.connect({ host: target.hostname, port: Number(target.port || 80) }, () => {
      const path = parseRequestTarget(req.url);
      const lines = [req.method + ' ' + path + ' HTTP/1.1'];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const entry of value) lines.push(name + ': ' + entry);
        else lines.push(name + ': ' + value);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
    });

    let buffered = Buffer.alloc(0);
    // 'pending' until the upstream answer's head is read; then 'relay' (101,
    // keep both sockets together), 'terminal' (plain answer already written and
    // ended) or 'retry' (re-exchanging the cookie for another attempt).
    let mode = 'pending';

    const closeBoth = () => {
      if (!upstream.destroyed) upstream.destroy();
      if (!socket.destroyed) socket.destroy();
    };

    const onHead = (headText, rest) => {
      const lines = headText.split('\r\n');
      const statusLine = lines.shift() ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
      const status = match ? Number(match[1]) : 502;

      if (status === 101) {
        mode = 'relay';
        if (!socket.destroyed) socket.write(headText + '\r\n\r\n');
        if (rest.length > 0 && !socket.destroyed) socket.write(rest);
        upstream.on('data', (chunk) => {
          if (!socket.destroyed) socket.write(chunk);
        });
        socket.on('data', (chunk) => {
          if (!upstream.destroyed) upstream.write(chunk);
        });
        upstream.on('error', closeBoth);
        upstream.on('close', closeBoth);
        socket.on('error', closeBoth);
        socket.on('close', closeBoth);
        return;
      }

      const rawHeaders = {};
      for (const line of lines) {
        if (!line) continue;
        const index = line.indexOf(':');
        if (index <= 0) continue;
        const name = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (rawHeaders[name] === undefined) rawHeaders[name] = value;
        else if (Array.isArray(rawHeaders[name])) rawHeaders[name].push(value);
        else rawHeaders[name] = [rawHeaders[name], value];
      }

      const { headers: outHeaders, harvestedCookies } = rewriteResponseHeaders(rawHeaders, { publicBaseUrl: publicBaseUrl() });
      for (const harvested of harvestedCookies) opts.onDshCookie(harvested);

      if (status === 401 && attempt === 0) {
        mode = 'retry';
        upstream.destroy();
        Promise.resolve(opts.onAuthInvalid())
          .then(() => {
            const cookie = opts.dshCookie();
            const retryHeaders = { ...headers };
            if (cookie) retryHeaders.cookie = cookie;
            relayUpgrade(retryHeaders, req, socket, head, attempt + 1);
          })
          .catch(() => refuseUpgrade(socket, 502, 'Bad Gateway'));
        return;
      }

      mode = 'terminal';
      const out = [statusLine];
      for (const [name, value] of Object.entries(outHeaders)) {
        if (Array.isArray(value)) for (const entry of value) out.push(name + ': ' + entry);
        else out.push(name + ': ' + value);
      }
      out.push('connection: close');
      if (!socket.destroyed) {
        socket.write(out.join('\r\n') + '\r\n\r\n');
        if (rest.length > 0) socket.write(rest);
        socket.end();
      }
      upstream.destroy();
    };

    upstream.on('data', (chunk) => {
      if (mode !== 'pending') return;
      buffered = Buffer.concat([buffered, chunk]);
      const index = buffered.indexOf('\r\n\r\n');
      if (index === -1) {
        if (buffered.length > 64 * 1024) {
          refuseUpgrade(socket, 502, 'Bad Gateway');
          upstream.destroy();
        }
        return;
      }
      const headText = buffered.subarray(0, index).toString('latin1');
      const rest = buffered.subarray(index + 4);
      // Stop accumulating; the 101 path attaches its own data handler.
      upstream.removeAllListeners('data');
      onHead(headText, rest);
    });
    upstream.on('error', () => {
      if (mode === 'pending') refuseUpgrade(socket, 502, 'Bad Gateway');
      else if (mode === 'relay') closeBoth();
    });
    upstream.on('close', () => {
      if (mode === 'relay') closeBoth();
    });
    socket.on('error', closeBoth);
    socket.on('close', closeBoth);
  }

  const server = http.createServer(handleRequest);
  // Upgraded sockets leave the http.Server's own accounting, so a plain
  // server.close() would wait for a WebSocket that never ends. Track every
  // connection and destroy them on stop: unloading the plugin must actually
  // stop exposing this machine.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  return {
    server,
    /** Bind to loopback on an OS-assigned port. */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          port = server.address().port;
          resolve({ port });
        });
      });
    },
    /** The bound port (0 before listen). */
    get port() {
      return port;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
      agent.destroy();
    },
  };
}
