import test from 'node:test';
import assert from 'node:assert/strict';

// Load client.js the way the GUI does: through window.__ModuleLoader__.
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded.push(entry);
    },
  },
};

await import('../src/client.js');

function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  });
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  };
}

function moduleEntry() {
  assert.equal(loaded.length, 1);
  return loaded[0];
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object') collectText(node.props?.children, out);
  return out;
}

function makeClientCtx() {
  const registered = [];
  const calls = [];
  const effects = [];
  return {
    registered,
    calls,
    effects,
    ctx: {
      slots: {
        inject: (slot, factory) => factory(),
        register: (options, component) => {
          registered.push({ options, component });
          return () => {};
        },
      },
      locale: {
        register: () => () => {},
        getLocale: () => ({ active: 'en' }),
      },
      connection: {
        rpc: {
          // The real carrier answers a result envelope, not the bare payload.
          call: async (prefix, endpoint, payload) => {
            calls.push({ prefix, endpoint, payload });
            return {
              ok: true,
              value: { state: 'stopped', publicUrl: 'https://dsh.example.com', missing: [], logsTail: [], checksumAvailable: true },
            };
          },
        },
      },
      effect: (fn) => {
        effects.push(fn());
      },
    },
  };
}

test('client registers itself under the bundle package name', () => {
  const entry = moduleEntry();
  assert.equal(entry.id, 'dsh-frp');
  assert.equal(typeof entry.factory, 'function');
});

test('apply registers the bundle-config slot keyed by the package name', () => {
  const entry = moduleEntry();
  const Client = entry.factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error('unexpected require: ' + name);
  });
  assert.equal(Client.name, 'dsh-frp');
  assert.ok(Client.inject.includes('slots'));
  assert.ok(Client.inject.includes('connection'));

  const { ctx, registered, effects } = makeClientCtx();
  Client.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, 'plugins.bundle.config');
  assert.equal(registered[0].options.key, 'dsh-frp');
  assert.equal(typeof registered[0].component, 'function');
  assert.equal(effects.length, 1, 'locale cleanup is registered');
});

test('the injected props expose a translator and a one-shot call into the panel route', async () => {
  const entry = moduleEntry();
  const Client = entry.factory((name) => fakeReact());
  const { ctx, registered, calls } = makeClientCtx();
  Client.apply(ctx);
  const props = registered[0].options.inject();
  assert.equal(typeof props.t.title, 'string');
  const result = await props.call('status', {});
  assert.deepEqual(calls[0], { prefix: '/dsh-frp', endpoint: 'status', payload: {} });
  assert.equal(result.state, 'stopped', 'the panel sees the payload, not the rpc envelope');
});

test('a refused action rejects with the Host failure instead of returning it', async () => {
  const entry = moduleEntry();
  const Client = entry.factory((name) => fakeReact());
  const { ctx, registered } = makeClientCtx();
  ctx.connection.rpc.call = async () => ({
    ok: false,
    error: { code: 'start-gate', message: 'Cannot start: missing login-password', details: { missing: ['login-password'] } },
  });
  Client.apply(ctx);
  const props = registered[0].options.inject();
  await assert.rejects(() => props.call('start', {}), (error) => {
    assert.match(error.message, /missing login-password/);
    assert.equal(error.code, 'start-gate');
    return true;
  });
});

test('a result that is neither envelope nor payload is refused, not guessed at', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  assert.throws(() => Client.unwrapRpcResult(undefined, 'status'), /malformed rpc result/);
  assert.throws(() => Client.unwrapRpcResult({ state: 'stopped' }, 'status'), /malformed rpc result/);
  assert.equal(Client.unwrapRpcResult({ ok: true, value: { state: 'stopped' } }, 'status').state, 'stopped');
});

test('the panel renders its sections and the security notice', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const { ctx, registered } = makeClientCtx();
  Client.apply(ctx);
  const Component = registered[0].component;
  const props = registered[0].options.inject();
  const tree = Component(props);
  const text = collectText(tree).join(' ');
  for (const needle of ['frp tunnel', 'frps connection', 'Public sign-in', 'frpc runtime', 'Security', 'Start tunnel']) {
    assert.ok(text.includes(needle), 'panel shows: ' + needle);
  }
});

test('a save is confirmed by the autoStart it asked for', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  assert.equal(Client.satisfies({ autoStart: true }, { autoStart: true }), true);
  assert.equal(Client.satisfies({ autoStart: false }, { autoStart: true }), false);
  assert.equal(Client.satisfies({ state: 'stopped' }, {}), true, 'an unrelated save ignores the field');
});

test('the runtime card offers an auto-start switch that saves on click', async () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const { ctx, registered, calls } = makeClientCtx();
  const t = Client.messages.en;
  ctx.connection.rpc.call = async (prefix, endpoint, payload) => {
    calls.push({ prefix, endpoint, payload });
    return { ok: true, value: { state: 'stopped', missing: [], logsTail: [], autoStart: true } };
  };
  Client.apply(ctx);
  const tree = registered[0].component(registered[0].options.inject());

  const labels = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'label') labels.push(node);
    walk(node.props?.children);
  };
  walk(tree);

  const label = labels.find((node) => collectText(node).join('').includes(t.autoStart));
  assert.ok(label, 'the auto-start switch is rendered');
  assert.ok(collectText(tree).join(' ').includes(t.autoStartHint), 'the hint states the effect');

  const input = label.props.children[1];
  assert.equal(input.props.type, 'checkbox');
  assert.equal(input.props.checked, false, 'no status yet, so the box is unchecked rather than guessed');

  input.props.onChange({ target: { checked: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.find((record) => record.endpoint === 'setAutoStart'),
    { prefix: '/dsh-frp', endpoint: 'setAutoStart', payload: { autoStart: true } },
  );
});

test('the tunnel can be stopped from more than just the running state', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  assert.equal(Client.canStop('running'), true);
  assert.equal(Client.canStop('starting'), true);
  assert.equal(Client.canStop('error'), true);
  assert.equal(Client.canStop('stopped'), false);
  assert.equal(Client.canStop(undefined), false);
});

test('a dead gateway is surfaced as its own warning', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const t = Client.messages.en;
  assert.equal(Client.gatewayWarning({ gateway: 'ok' }, t), undefined);
  assert.match(Client.gatewayWarning({ gateway: 'error', gatewayMessage: 'EADDRINUSE' }, t), /gateway/i);
  assert.match(Client.gatewayWarning({ gateway: 'error', gatewayMessage: 'EADDRINUSE' }, t), /EADDRINUSE/);
});

test('a version without an embedded checksum needs consent once', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  assert.equal(Client.needsChecksumConsent(undefined), false);
  assert.equal(Client.needsChecksumConsent({ checksumAvailable: true }), false);
  assert.equal(Client.needsChecksumConsent({ checksumAvailable: false }), true);
});

test('the copyable nginx snippet keeps Host and the upgrade headers', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  for (const needle of ['proxy_set_header Host $host;', 'proxy_set_header Upgrade $http_upgrade;', 'proxy_read_timeout 3600s']) {
    assert.ok(Client.nginxSnippet.includes(needle), 'snippet contains: ' + needle);
  }
});

test('every panel string exists in both languages', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const zh = Client.messages.zh;
  const en = Client.messages.en;
  const walk = (left, right, path) => {
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), 'key set differs at ' + (path || 'root'));
    for (const key of Object.keys(left)) {
      if (left[key] && typeof left[key] === 'object') walk(left[key], right[key], path ? path + '.' + key : key);
      else assert.equal(typeof right[key], 'string', 'missing translation at ' + path + '.' + key);
    }
  };
  walk(zh, en, '');
});

test('the unconfigured hint is Chinese and names the missing fields', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const t = Client.messages.zh;
  const text = Client.statusText(
    { state: 'not-configured', reason: { code: 'not-configured', params: { missing: ['login-password', 'frps-token'] } } },
    t,
  );
  assert.match(text, /未配置/);
  assert.match(text, /公网登录密码/);
  assert.match(text, /frps 认证 token/);
  assert.doesNotMatch(text, /Missing:/, 'the Host sentence must not leak into a Chinese panel');

  const en = Client.statusText({ state: 'not-configured', reason: { code: 'not-configured', params: { missing: ['frps-token'] } } }, Client.messages.en);
  assert.match(en, /Not configured/);
  assert.match(en, /frps auth token/);
});

test('host diagnostics are localized by reason code, never shown raw', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const t = Client.messages.zh;
  const statuses = [
    [{ code: 'start-timeout', params: { seconds: 30 } }, /30 秒/],
    [{ code: 'proxy-error', params: { status: 'start error', detail: 'port already used' } }, /port already used/],
    [{ code: 'crash-loop', params: { count: 5, exitCode: '7' } }, /连续 5 次/],
    [{ code: 'frpc-exited', params: { exitCode: '1', delayMs: 1000 } }, /退出码 1/],
    [{ code: 'waiting-proxy', params: { status: 'new' } }, /等待 frps 登记/],
    [{ code: 'admin-unreachable' }, /管理接口/],
  ];
  for (const [reason, expected] of statuses) {
    const text = Client.statusText({ state: 'starting', message: 'raw english', reason }, t);
    assert.match(text, expected, reason.code + ' is localized');
    assert.doesNotMatch(text, /raw english/);
  }
  // An unknown reason falls back to the Host message instead of rendering nothing.
  assert.equal(Client.statusText({ state: 'error', message: 'boom', reason: { code: 'unknown-code' } }, t), 'boom');
});

test('rejections are explained in Chinese by code', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const t = Client.messages.zh;

  const gate = new Error('Cannot start: missing login-password');
  gate.code = 'start-gate';
  gate.details = { missing: ['login-password'] };
  assert.match(Client.describeError(gate, t), /还缺：公网登录密码/);

  const short = new Error('password must be at least 12 characters');
  short.code = 'password-too-short';
  short.details = { min: 12 };
  assert.match(Client.describeError(short, t), /12/);

  const domain = new Error('domain must be a plain domain name');
  domain.code = 'invalid-domain';
  domain.details = { field: 'domain' };
  assert.match(Client.describeError(domain, t), /域名/);

  const empty = new Error('serverAddr must not be empty');
  empty.code = 'empty-field';
  empty.details = { field: 'serverAddr' };
  assert.match(Client.describeError(empty, t), /服务器地址不能为空/);

  // No code: the raw message is better than pretending to translate it.
  assert.equal(Client.describeError(new Error('EACCES: permission denied'), t), 'EACCES: permission denied');
});

test('a host rejection is distinguished from a transport failure', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  try {
    Client.unwrapRpcResult({ ok: false, error: { code: 'invalid-port', message: 'bad port', details: { field: 'serverPort' } } }, 'setFrpsConfig');
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error.hostRejected, true, 'a refusal from the Host is final');
    assert.equal(error.details.field, 'serverPort');
  }
  // A successful envelope carries no such flag; the caller never sees one.
  assert.equal(Client.unwrapRpcResult({ ok: true, value: { ok: true } }, 'setFrpsToken').ok, true);
});

test('a save is only confirmed when status shows the saved values', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  assert.equal(Client.satisfies({ serverAddr: 'a.example.com', serverPort: 7000 }, { serverAddr: 'a.example.com', serverPort: '7000' }), true);
  assert.equal(Client.satisfies({ serverAddr: 'b.example.com' }, { serverAddr: 'a.example.com' }), false);
  assert.equal(Client.satisfies({ hasFrpsToken: true }, { hasFrpsToken: true }), true);
  assert.equal(Client.satisfies({ hasFrpsToken: false }, { hasFrpsToken: true }), false);
  assert.equal(Client.satisfies({ configuredBinaryPath: '/opt/frpc' }, { configuredBinaryPath: '/opt/frpc' }), true);
  assert.equal(Client.satisfies(undefined, {}), false);
});

test('a save notice states the outcome and what still has to be done', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  const zh = Client.messages.zh;
  const notice = { tone: 'ok', parts: [{ key: 'saveOk', params: { what: zh.savedWhat.frps } }, { next: true }] };

  // The next-step clause follows the status on screen, not the status at save
  // time: the reload that applies a save stops the tunnel.
  const running = Client.noticeText(notice, zh, { state: 'running', missing: [], binaryPath: '/usr/local/bin/frpc' });
  assert.match(running, /已保存/);
  assert.match(running, /frps 连接配置/);
  assert.match(running, /再「启动隧道」/);

  const stopped = Client.noticeText(notice, zh, { state: 'stopped', missing: [], binaryPath: '/usr/local/bin/frpc' });
  assert.match(stopped, /点「启动隧道」/);

  const incomplete = Client.noticeText(notice, zh, { state: 'not-configured', missing: ['frps-token'], reason: {} });
  assert.match(incomplete, /先补齐 frps 认证 token/);

  const nosBinary = Client.noticeText(notice, zh, { state: 'stopped', missing: [] });
  assert.match(nosBinary, /先准备 frpc/);

  // Without a status the outcome still shows, just without the advice.
  const bare = Client.noticeText(notice, zh, undefined);
  assert.match(bare, /已保存/);
  assert.doesNotMatch(bare, /下一步/);
});
