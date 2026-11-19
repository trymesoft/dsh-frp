// Header normalization for the dsh-frp gateway.
//
// The DSH GUI applies a request fence of its own (Host must be loopback/bind,
// Origin must match the authority, cross-site fetches are refused). The gateway
// is the only place allowed to satisfy that fence on a stranger's behalf, so
// every rule about which header is rewritten, dropped or overwritten lives
// here as a pure function: testable without sockets, and auditable in one file.
//
// Headers are plain objects with lowercase keys; a multi-valued header is an
// array (Node gives Set-Cookie that way).

export const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
];

const FENCE_DROP_REQUEST = [
  'origin',
  'sec-fetch-site',
  'x-real-ip',
  'forwarded',
  'x-forwarded-proto',
  'x-forwarded-host',
];

function lowerKey(key) {
  return String(key).toLowerCase();
}

function valuesOf(value) {
  return Array.isArray(value) ? value : [value];
}

/** Header names listed inside a Connection header value, per RFC 7230 §6.1. */
function connectionNamed(headers) {
  const raw = headers.connection;
  if (!raw) return [];
  return valuesOf(raw)
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Drop hop-by-hop headers: the fixed list, whatever Connection names, and
 * Proxy-Connection (which some proxies still emit).
 */
export function stripHopByHop(headers) {
  const named = new Set([...HOP_BY_HOP, ...connectionNamed(headers ?? {})]);
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = lowerKey(key);
    if (named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * True when a request carries both Transfer-Encoding and Content-Length — the
 * classic request-smuggling shape. Node's parser rejects most of these before
 * we see them; this is the second layer for anything that slips through.
 */
export function hasFramingConflict(headers) {
  const has = (name) => Object.keys(headers ?? {}).some((key) => lowerKey(key) === name);
  return has('transfer-encoding') && has('content-length');
}

/**
 * The real client IP, taken from the second-to-last X-Forwarded-For entry.
 *
 * The documented nginx snippet overwrites XFF with $remote_addr, and frps then
 * appends the address it saw (the loopback peer), so a correctly configured
 * chain always has at least two entries and the client sits second from the
 * end. A single entry means the header did not come through that chain, and
 * we refuse to trust it.
 */
export function clientIpFromXff(xff) {
  if (typeof xff !== 'string') return undefined;
  const entries = xff
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length < 2) return undefined;
  return entries[entries.length - 2];
}

/**
 * Rewrite an inbound request's headers into what the DSH GUI expects.
 *
 * @param {object} headers inbound headers (lowercase keys)
 * @param {{ targetAuthority: string, clientIp?: string }} opts
 *   targetAuthority is the GUI's own authority; clientIp is the visitor's
 *   address recovered from the trusted XFF chain.
 */
export function normalizeRequestHeaders(headers, opts) {
  const out = stripHopByHop(headers);
  for (const name of FENCE_DROP_REQUEST) delete out[name];
  out.host = opts.targetAuthority;
  if (opts.clientIp) out['x-forwarded-for'] = opts.clientIp;
  else delete out['x-forwarded-for'];
  return out;
}

/**
 * Rewrite an upstream Location header into an absolute public URL, so the
 * browser never learns the loopback origin and never gets a dead link.
 */
export function rewriteLocation(location, publicBaseUrl) {
  const base = String(publicBaseUrl).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(String(location), base + '/');
  } catch {
    return base + '/';
  }
  return base + parsed.pathname + parsed.search + parsed.hash;
}

/**
 * Rewrite an upstream response's headers for the browser.
 *
 * Set-Cookie / Set-Cookie2 are harvested first and always stripped: the DSH
 * signed cookie stays inside the gateway, and this function is the single
 * place that guarantees it.
 *
 * @returns {{ headers: object, harvestedCookies: string[] }}
 */
export function rewriteResponseHeaders(headers, opts) {
  const harvestedCookies = [];
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = lowerKey(key);
    if (name === 'set-cookie' || name === 'set-cookie2') {
      for (const cookie of valuesOf(value)) harvestedCookies.push(String(cookie));
      continue;
    }
    out[name] = value;
  }
  const stripped = stripHopByHop(out);
  if (typeof stripped.location === 'string') {
    stripped.location = rewriteLocation(stripped.location, opts.publicBaseUrl);
  }
  return { headers: stripped, harvestedCookies };
}

/** Absolute-form request targets become path-form; path-form is returned as is. */
export function parseRequestTarget(url) {
  const text = String(url ?? '');
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.pathname + parsed.search;
  } catch {
    return text;
  }
}
