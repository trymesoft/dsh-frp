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

await import('../client.js');

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
          call: async (prefix, endpoint, payload) => {
            calls.push({ prefix, endpoint, payload });
            return { state: 'stopped', publicUrl: 'https://dsh.example.com', missing: [], logsTail: [], checksumAvailable: true };
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
  assert.equal(entry.id, '@local/dsh-frp');
  assert.equal(typeof entry.factory, 'function');
});

test('apply registers the bundle-config slot keyed by the package name', () => {
  const entry = moduleEntry();
  const Client = entry.factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error('unexpected require: ' + name);
  });
  assert.equal(Client.name, '@local/dsh-frp');
  assert.ok(Client.inject.includes('slots'));
  assert.ok(Client.inject.includes('connection'));

  const { ctx, registered, effects } = makeClientCtx();
  Client.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, 'plugins.bundle.config');
  assert.equal(registered[0].options.key, '@local/dsh-frp');
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
  await props.call('status', {});
  assert.deepEqual(calls[0], { prefix: '/dsh-frp', endpoint: 'status', payload: {} });
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
  assert.equal(Client.needsChecksumConsent({ checksumAvailable: false, noChecksumConfirmed: false }), true);
  assert.equal(Client.needsChecksumConsent({ checksumAvailable: false, noChecksumConfirmed: true }), false);
});

test('the copyable nginx snippet keeps Host and the upgrade headers', () => {
  const entry = moduleEntry();
  const Client = entry.factory(() => fakeReact());
  for (const needle of ['proxy_set_header Host $host;', 'proxy_set_header Upgrade $http_upgrade;', 'proxy_read_timeout 3600s']) {
    assert.ok(Client.nginxSnippet.includes(needle), 'snippet contains: ' + needle);
  }
});
