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

/** Copy for the public entrance. The panel has its own dictionary in client.js. */
const LOGIN_TEXT = {
  zh: {
    lang: 'zh-CN',
    title: 'DSH 公网入口 · 登录',
    brandSub: '公网入口',
    themeToggle: '切换明暗主题',
    themeToLight: '切换到浅色模式',
    themeToDark: '切换到深色模式',
    chip: '已认证',
    heading: '登录以继续',
    lead: '这台机器上的 <b>DSH</b> 正通过 <b>frp</b> 隧道对外提供服务，入口由插件网关把关。',
    tunnelFallback: 'frps → 本机 DSH',
    username: '用户名',
    usernamePlaceholder: '你的用户名',
    password: '密码',
    passwordPlaceholder: '你的密码',
    submit: '进入 DSH',
    note: '会话会自动过期；在 DSH 插件面板里修改密码会立即注销所有已登录设备。',
    footer: '经 frps 转发',
    badCredentials: '用户名或密码不正确，请重试。',
  },
  en: {
    lang: 'en',
    title: 'DSH public entrance · Sign in',
    brandSub: 'Public entrance',
    themeToggle: 'Toggle light and dark theme',
    themeToLight: 'Switch to light mode',
    themeToDark: 'Switch to dark mode',
    chip: 'authenticated',
    heading: 'Sign in to continue',
    lead: 'The <b>DSH</b> on this machine is published through an <b>frp</b> tunnel, and this plugin\'s gateway guards the entrance.',
    tunnelFallback: 'frps → this DSH',
    username: 'Username',
    usernamePlaceholder: 'Your username',
    password: 'Password',
    passwordPlaceholder: 'Your password',
    submit: 'Enter DSH',
    note: 'Sessions expire automatically. Changing the password in the DSH plugin panel signs out every device immediately.',
    footer: 'forwarded via frps',
    badCredentials: 'Incorrect username or password. Try again.',
  },
};

/**
 * Pick the entrance language from an Accept-Language header.
 *
 * Only Chinese and English exist, so this is a ranked scan: tags with the
 * highest q-value first, unsupported languages skipped. No header (or no
 * usable tag) means English.
 *
 * @param {string | undefined} acceptLanguage
 * @returns {'zh' | 'en'}
 */
export function negotiateLocale(acceptLanguage) {
  const ranked = String(acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const quality = params.map((entry) => entry.trim()).find((entry) => entry.startsWith('q='));
      const q = quality ? Number(quality.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((left, right) => right.q - left.q);
  for (const { tag } of ranked) {
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

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

/**
 * The login page: self-contained, no external resources, no cache.
 *
 * The visitor is a stranger on someone else's tunnel, so the page has to say
 * three things at once: this is a DSH instance, it arrives through an frp
 * tunnel, and the gateway — not DSH — is asking for the password. It ships its
 * own light/dark toggle (remembered in localStorage, defaulting to the system
 * preference) because a tunnel entrance is often opened on a phone at night.
 *
 * Every string lives in LOGIN_TEXT so the page can follow the visitor's
 * Accept-Language (Chinese browsers get Chinese, everyone else gets English).
 *
 * @param {{locale?: 'zh'|'en', error?: string, domain?: string}} [options]
 *   error is a code ("bad-credentials") or literal text for a test
 */
export function loginHtml(options = {}) {
  const locale = options.locale === 'zh' ? 'zh' : 'en';
  const t = LOGIN_TEXT[locale];
  const domain = options.domain ? String(options.domain) : '';
  const message = options.error === 'bad-credentials' ? t.badCredentials : options.error;
  const errorBlock = message
    ? '<p class="error" data-login-error role="alert"><span aria-hidden="true">!</span>' + escapeHtml(message) + '</p>'
    : '';
  const domainBlock = domain
    ? '<span class="mono">' + escapeHtml(domain) + '</span>'
    : '<span class="mono">' + t.tunnelFallback + '</span>';
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<title>${t.title}</title>
<script>
  /* Set the theme before the first paint: stored choice, else the system one. */
  (function () {
    var theme = 'dark';
    try {
      var saved = localStorage.getItem('dsh-frp:theme');
      if (saved === 'light' || saved === 'dark') theme = saved;
      else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
    } catch (error) {}
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  })();
</script>
<style>
  :root {
    --bg: #05070e; --bg-deep: #02040a; --panel: rgba(14, 20, 36, .74);
    --line: rgba(120, 160, 255, .16); --line-strong: rgba(120, 160, 255, .32);
    --text: #e9eefc; --muted: #93a4c6; --dim: #64749a;
    --accent: #4d8dff; --accent-soft: rgba(77, 141, 255, .16); --accent-2: #3ee0c0;
    --danger: #ff6b81; --danger-soft: rgba(255, 107, 129, .12);
    --grid: rgba(110, 150, 255, .07); --glow-a: rgba(58, 108, 255, .30); --glow-b: rgba(62, 224, 192, .16);
    --shadow: 0 30px 80px -30px rgba(0, 0, 0, .85);
  }
  html[data-theme="light"] {
    --bg: #eef2fa; --bg-deep: #f8fafd; --panel: rgba(255, 255, 255, .84);
    --line: rgba(24, 46, 94, .12); --line-strong: rgba(24, 46, 94, .22);
    --text: #0d1b33; --muted: #52628a; --dim: #7c89a8;
    --accent: #2159d8; --accent-soft: rgba(33, 89, 216, .10); --accent-2: #0c8f7c;
    --danger: #cf2f4b; --danger-soft: rgba(207, 47, 75, .08);
    --grid: rgba(33, 89, 216, .07); --glow-a: rgba(33, 89, 216, .16); --glow-b: rgba(12, 143, 124, .12);
    --shadow: 0 30px 70px -40px rgba(16, 34, 70, .45);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 24px; display: grid; place-items: center;
    background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background .3s ease, color .3s ease;
  }
  /* Background: a faint engineering grid plus two soft light sources. */
  .backdrop { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
  .backdrop::before {
    content: ""; position: absolute; inset: -20%;
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
    -webkit-mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
  }
  .backdrop::after {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(560px 420px at 18% 12%, var(--glow-a), transparent 70%),
      radial-gradient(520px 400px at 84% 88%, var(--glow-b), transparent 70%);
    opacity: .9;
  }
  .shell { position: relative; width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 18px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .mark {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    border: 1px solid var(--line-strong); background: var(--accent-soft); color: var(--accent);
  }
  .brand strong { display: block; font-size: 15px; letter-spacing: .12em; }
  .brand small { display: block; font-size: 11px; color: var(--muted); letter-spacing: .22em; }
  .theme {
    width: 36px; height: 36px; display: grid; place-items: center;
    border-radius: 10px; border: 1px solid var(--line); background: transparent;
    color: var(--muted); cursor: pointer; transition: color .2s ease, border-color .2s ease, background .2s ease;
  }
  .theme:hover { color: var(--text); border-color: var(--line-strong); background: var(--accent-soft); }
  .theme svg { width: 17px; height: 17px; }
  html[data-theme="dark"] .theme .icon-sun { display: block; }
  html[data-theme="dark"] .theme .icon-moon { display: none; }
  html[data-theme="light"] .theme .icon-sun { display: none; }
  html[data-theme="light"] .theme .icon-moon { display: block; }

  .card {
    position: relative; padding: 26px 24px 22px; border-radius: 18px;
    border: 1px solid var(--line); background: var(--panel); box-shadow: var(--shadow);
    backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2);
    transition: background .3s ease, border-color .3s ease;
  }
  .card::before {
    content: ""; position: absolute; inset: 0 0 auto; height: 1px; border-radius: 18px 18px 0 0;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-2), transparent);
    opacity: .7;
  }
  .chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .chip {
    font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em;
    padding: 5px 9px; border-radius: 999px; border: 1px solid var(--line-strong);
    color: var(--muted); background: transparent; text-transform: uppercase;
  }
  .chip-live { display: inline-flex; align-items: center; gap: 6px; color: var(--accent-2); border-color: color-mix(in srgb, var(--accent-2) 42%, transparent); }
  .chip-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 0 0 currentColor; animation: pulse 2.4s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--accent-2); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 650; letter-spacing: -.01em; }
  .lead { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
  .lead b { color: var(--text); font-weight: 600; }

  /* The tunnel: frps on the left, this DSH on the right, traffic in between. */
  .tunnel { display: flex; align-items: center; gap: 10px; margin: 0 0 22px; }
  .tunnel .node {
    font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em;
    padding: 6px 9px; border-radius: 8px; border: 1px solid var(--line-strong); color: var(--muted);
  }
  .tunnel .node-dsh { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
  .tunnel .wire { position: relative; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line-strong), var(--accent-2), var(--line-strong)); opacity: .8; }
  .tunnel .wire::after {
    content: ""; position: absolute; top: -2px; width: 5px; height: 5px; border-radius: 50%;
    background: var(--accent-2); box-shadow: 0 0 10px var(--accent-2);
    animation: travel 3.2s linear infinite;
  }
  @keyframes travel { 0% { left: 0; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { left: 100%; opacity: 0; } }

  label { display: block; font-size: 12px; letter-spacing: .04em; color: var(--muted); margin: 16px 0 7px; }
  input {
    width: 100%; padding: 11px 13px; border-radius: 10px; font-size: 15px;
    border: 1px solid var(--line); background: color-mix(in srgb, var(--text) 4%, transparent);
    color: var(--text); transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
  }
  input::placeholder { color: var(--dim); }
  input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft); background: transparent;
  }
  button[type="submit"] {
    width: 100%; margin-top: 22px; padding: 12px 14px; border: 0; border-radius: 10px;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    background: var(--accent);
    background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 65%, var(--accent-2)));
    color: #fff; font-size: 15px; font-weight: 600; letter-spacing: .02em; cursor: pointer;
    box-shadow: 0 12px 28px -14px color-mix(in srgb, var(--accent) 85%, transparent);
    transition: transform .15s ease, box-shadow .18s ease, filter .18s ease;
  }
  button[type="submit"]:hover { filter: brightness(1.06); box-shadow: 0 16px 32px -14px color-mix(in srgb, var(--accent) 95%, transparent); }
  button[type="submit"]:active { transform: translateY(1px); }
  button[type="submit"]:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  button[type="submit"] svg { width: 16px; height: 16px; }

  .error {
    display: flex; align-items: flex-start; gap: 8px; margin: 0 0 4px; padding: 10px 12px;
    border-radius: 10px; border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
    background: var(--danger-soft); color: var(--danger); font-size: 13px;
  }
  .error span { font-weight: 700; }
  .note { margin: 18px 0 0; color: var(--dim); font-size: 12px; }
  .foot {
    display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;
    color: var(--dim); font-size: 11px; letter-spacing: .04em;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sep { opacity: .5; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  @media (max-width: 420px) {
    body { padding: 16px; }
    .card { padding: 22px 18px 18px; }
  }
</style>
</head>
<body>
  <div class="backdrop" aria-hidden="true"></div>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"></path>
            <path d="M12 12v9M4 7.5 12 12l8-4.5"></path>
          </svg>
        </span>
        <div>
          <strong>DSH</strong>
          <small>${t.brandSub}</small>
        </div>
      </div>
      <button id="theme" class="theme" type="button" aria-label="${t.themeToggle}" title="${t.themeToggle}">
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <circle cx="12" cy="12" r="4.2"></circle>
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"></path>
        </svg>
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5z"></path>
        </svg>
      </button>
    </header>

    <section class="card">
      <div class="chips">
        <span class="chip">frp tunnel</span>
        <span class="chip chip-live"><i></i>${t.chip}</span>
      </div>
      <h1>${t.heading}</h1>
      <p class="lead">${t.lead}</p>

      <div class="tunnel" aria-hidden="true">
        <span class="node">frps</span>
        <span class="wire"></span>
        <span class="node node-dsh">DSH</span>
      </div>

      ${errorBlock}
      <form method="post" action="${LOGIN_PATH}" autocomplete="on">
        <label for="username">${t.username}</label>
        <input id="username" name="username" type="text" autocapitalize="none" autocomplete="username" placeholder="${t.usernamePlaceholder}" required>
        <label for="password">${t.password}</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="${t.passwordPlaceholder}" required>
        <button type="submit">
          ${t.submit}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6"></path>
          </svg>
        </button>
      </form>
      <p class="note">${t.note}</p>
    </section>

    <footer class="foot">
      <span>${t.footer}</span>
      <span class="sep">·</span>
      ${domainBlock}
    </footer>
  </main>
  <script>
    (function () {
      var root = document.documentElement;
      var button = document.getElementById('theme');
      if (!button) return;
      function label(theme) {
        var text = theme === 'dark' ? ${JSON.stringify(t.themeToLight)} : ${JSON.stringify(t.themeToDark)};
        button.setAttribute('aria-label', text);
        button.setAttribute('title', text);
      }
      label(root.getAttribute('data-theme') || 'dark');
      button.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        root.style.colorScheme = next;
        label(next);
        try { localStorage.setItem('dsh-frp:theme', next); } catch (error) {}
      });
    })();
  </script>
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

/** 502 copy; the reason is a code so the page can stay localizable. */
const ERROR_TEXT = {
  zh: {
    lang: 'zh-CN',
    title: '502 · DSH 暂时无法访问',
    body: '这个入口后面的 DSH 没有响应，请稍后重试；如果持续出现，请检查本机 DSH 是否在运行。',
    reasons: {
      'target-unresolved': '网关无法解析本机 GUI 地址',
      'session-refresh-failed': '网关无法刷新 DSH 会话',
      'upstream-unreachable': '本机 DSH 没有应答',
    },
  },
  en: {
    lang: 'en',
    title: '502 · DSH is unreachable',
    body: 'The DSH behind this entrance is not answering. Try again shortly; if it persists, check that DSH is running on the host machine.',
    reasons: {
      'target-unresolved': 'the gateway cannot resolve the local GUI address',
      'session-refresh-failed': 'the gateway could not refresh its DSH session',
      'upstream-unreachable': 'the local DSH did not answer',
    },
  },
};

function badGatewayPage(reason, locale = 'en') {
  const t = ERROR_TEXT[locale === 'zh' ? 'zh' : 'en'];
  const detail = t.reasons[reason] ?? String(reason);
  return `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><title>${t.title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
main{max-width:440px}h1{font-size:18px;margin:0 0 10px}p{margin:0;opacity:.75}code{font:12px/1.6 ui-monospace,Menlo,monospace;opacity:.7}</style></head>
<body><main><h1>${t.title}</h1><p>${t.body}</p><p><code>${escapeHtml(detail)}</code></p></main></body></html>`;
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

  function localeOf(req) {
    return negotiateLocale(req.headers['accept-language']);
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

  /**
   * Login attempts are serialized.
   *
   * The throttle raises the delay only after a failure, so parallel attempts
   * would all read the same pre-failure delay and then be checked together,
   * letting a burst try many passwords per interval. One queue means each
   * attempt waits for the delay the previous failure established.
   */
  let loginQueue = Promise.resolve();

  function handleLogin(req, res) {
    const run = loginQueue.then(() => performLogin(req, res));
    loginQueue = run.catch(() => {});
    return run;
  }

  async function performLogin(req, res) {
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
    const locale = localeOf(req);
    let target;
    try {
      target = new URL(opts.targetOrigin());
    } catch {
      sendHtml(res, 502, badGatewayPage('target-unresolved', locale));
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
            .catch(() => sendHtml(res, 502, badGatewayPage('session-refresh-failed', locale)));
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });

    upstreamReq.on('error', () => {
      if (!res.headersSent) sendHtml(res, 502, badGatewayPage('upstream-unreachable', locale));
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
        const error = query.searchParams.has('e') ? 'bad-credentials' : undefined;
        sendHtml(res, 200, loginPageOf({ locale: localeOf(req), error, domain: opts.publicDomain?.() }));
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
        // A 101 is byte-transparent only after its head: the head still obeys
        // the response rules, so no Set-Cookie may reach the browser.
        const relayed = [statusLine];
        for (const line of lines) {
          const index = line.indexOf(':');
          if (index > 0) {
            const name = line.slice(0, index).trim().toLowerCase();
            if (name === 'set-cookie' || name === 'set-cookie2') {
              opts.onDshCookie(line.slice(index + 1).trim());
              continue;
            }
          }
          relayed.push(line);
        }
        if (!socket.destroyed) socket.write(relayed.join('\r\n') + '\r\n\r\n');
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
