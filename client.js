/**
 * dsh-frp — Client half.
 *
 * A panel in the bundle config slot (Plugins → dsh-frp): tunnel status, frps
 * connection form, public login credentials, frpc runtime controls and logs.
 * It talks to the Host half through the plugin's own prefix route with a
 * one-shot RPC per action, and polls status while mounted.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-frp',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = '@local/dsh-frp';
    const PREFIX = '/dsh-frp';

    const MESSAGES = {
      zh: {
        title: '公网穿透（frp）',
        subtitle: '经自有 frps 把本机 DSH 暴露到公网域名，入口先过本插件的登录页。',
        state: {
          'not-configured': '未配置',
          'need-binary': '需要 frpc 二进制',
          downloading: '下载中',
          stopped: '已停止',
          starting: '启动中',
          running: '运行中',
          error: '错误',
        },
        publicUrl: '公网地址',
        copy: '复制',
        copied: '已复制',
        missing: '缺少',
        frps: 'frps 连接',
        serverAddr: '服务器地址',
        serverPort: '服务器端口',
        domain: '公网域名',
        publicBaseUrl: '公网入口 URL（含协议）',
        useTls: '启用传输 TLS',
        token: 'frps 认证 token',
        save: '保存',
        restartHint: '保存后插件将重新加载以应用连接参数。',
        login: '公网登录',
        username: '用户名',
        password: '密码（至少 12 位）',
        setLogin: '更新登录凭据',
        kickHint: '改密码会立即注销所有已登录设备。',
        runtime: 'frpc 运行',
        start: '启动隧道',
        stop: '停止隧道',
        binary: 'frpc 二进制',
        binaryDownload: '自动下载（校验 sha256）',
        binaryPath: '使用本机路径',
        binaryPathPlaceholder: '/usr/local/bin/frpc',
        confirmNoChecksum: '此版本没有内嵌校验和，下载内容无法验证。仍要继续吗？',
        noChecksum: '无校验和',
        logs: '日志',
        showLogs: '展开日志',
        hideLogs: '收起日志',
        security: '安全提示',
        securityBody: '这个入口拥有本机 Agent 的完全控制权（包括这个配置面板）。请使用强密码；入口为单用户视角，没有并发隔离。',
        nginx: '复制 nginx 配置片段',
        gate: '启动前还需补齐：',
        gatewayPort: '网关端口',
        proxyState: '代理状态',
      },
      en: {
        title: 'frp tunnel',
        subtitle: 'Expose this DSH through your own frps domain. Visitors sign in to this plugin first.',
        state: {
          'not-configured': 'Not configured',
          'need-binary': 'frpc binary required',
          downloading: 'Downloading',
          stopped: 'Stopped',
          starting: 'Starting',
          running: 'Running',
          error: 'Error',
        },
        publicUrl: 'Public URL',
        copy: 'Copy',
        copied: 'Copied',
        missing: 'Missing',
        frps: 'frps connection',
        serverAddr: 'Server address',
        serverPort: 'Server port',
        domain: 'Public domain',
        publicBaseUrl: 'Public entrance URL (with scheme)',
        useTls: 'Transport TLS',
        token: 'frps auth token',
        save: 'Save',
        restartHint: 'Saving reloads the plugin so the connection parameters apply.',
        login: 'Public sign-in',
        username: 'Username',
        password: 'Password (12+ characters)',
        setLogin: 'Update sign-in credentials',
        kickHint: 'Changing the password signs every device out immediately.',
        runtime: 'frpc runtime',
        start: 'Start tunnel',
        stop: 'Stop tunnel',
        binary: 'frpc binary',
        binaryDownload: 'Download automatically (sha256 verified)',
        binaryPath: 'Use a local path',
        binaryPathPlaceholder: '/usr/local/bin/frpc',
        confirmNoChecksum: 'This version has no embedded checksum, so the download cannot be verified. Continue anyway?',
        noChecksum: 'no checksum',
        logs: 'Logs',
        showLogs: 'Show logs',
        hideLogs: 'Hide logs',
        security: 'Security',
        securityBody: 'This entrance has full control of this machine\'s agent, including this panel. Use a strong password; it is a single-user view with no per-user isolation.',
        nginx: 'Copy nginx snippet',
        gate: 'Still required before starting:',
        gatewayPort: 'Gateway port',
        proxyState: 'Proxy state',
      },
    };

    const NGINX_SNIPPET = [
      'map $http_upgrade $connection_upgrade { default upgrade; \'\' close; }',
      'server {',
      '  listen 443 ssl;',
      '  server_name dsh.example.com;',
      '  location / {',
      '    proxy_pass http://127.0.0.1:17002;          # frps vhostHTTPPort',
      '    proxy_http_version 1.1;',
      '    proxy_set_header Host $host;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection $connection_upgrade;',
      '    proxy_set_header X-Forwarded-For $remote_addr;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
      '    proxy_read_timeout 3600s; proxy_send_timeout 3600s;',
      '    client_max_body_size 50m;',
      '  }',
      '}',
    ].join('\n');

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', color: 'var(--dsw-alias-text-primary, inherit)', font: 'inherit' },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        borderRadius: '12px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: '12px', opacity: 0.72, minWidth: '132px' },
      input: {
        flex: '1 1 180px',
        minWidth: '120px',
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      button: {
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      primary: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #4c8dff)',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
      },
      h3: { margin: 0, fontSize: '13px', fontWeight: 600, letterSpacing: '.01em' },
      hint: { margin: 0, fontSize: '12px', opacity: 0.7 },
      code: {
        margin: 0,
        padding: '10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-inset, rgba(128,128,128,.12))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        lineHeight: 1.5,
        maxHeight: '220px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
      },
      badge: { padding: '2px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid currentColor' },
      error: { color: 'var(--dsw-alias-text-danger, #ff6b6b)', fontSize: '12px', margin: 0 },
    };

    function field(label, value, onChange, opts = {}) {
      return h(
        'label',
        { style: styles.row, key: opts.key ?? label },
        h('span', { style: styles.label }, label),
        h('input', {
          style: styles.input,
          type: opts.type ?? 'text',
          value: value ?? '',
          placeholder: opts.placeholder ?? '',
          autoComplete: opts.autoComplete ?? 'off',
          onChange: (event) => onChange(event.target.value),
        }),
      );
    }

    function Panel(props) {
      const t = props.t;
      const call = props.call;
      const [status, setStatus] = React.useState(undefined);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [showLogs, setShowLogs] = React.useState(false);
      const [copied, setCopied] = React.useState('');
      const [form, setForm] = React.useState({ serverAddr: '', serverPort: '', domain: '', publicBaseUrl: '', useTLS: true, token: '', username: '', password: '', binaryPath: '' });
      const [seeded, setSeeded] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const pull = async () => {
          try {
            const next = await call('status', {});
            if (!alive) return;
            setStatus(next);
            setError('');
          } catch (reason) {
            if (alive) setError(String(reason && reason.message ? reason.message : reason));
          }
        };
        void pull();
        const timer = setInterval(pull, 1500);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [call]);

      React.useEffect(() => {
        if (seeded || !status) return;
        setForm((current) => ({
          ...current,
          serverAddr: status.serverAddr ?? '',
          serverPort: String(status.serverPort ?? ''),
          domain: status.domain ?? '',
          publicBaseUrl: status.publicUrl ?? '',
          useTLS: Boolean(status.useTls),
          username: status.username ?? '',
          binaryPath: status.binaryPath ?? '',
        }));
        setSeeded(true);
      }, [status, seeded]);

      const run = async (endpoint, payload, done) => {
        setBusy(true);
        setError('');
        try {
          const result = await call(endpoint, payload ?? {});
          if (typeof done === 'function') done(result);
          const next = await call('status', {});
          setStatus(next);
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };

      const copy = async (text, what) => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(what);
          setTimeout(() => setCopied(''), 1500);
        } catch {
          setCopied('');
        }
      };

      const state = status ? status.state : undefined;
      const stateLabel = state ? (t.state[state] ?? state) : '…';
      const missing = status && Array.isArray(status.missing) ? status.missing : [];

      return h(
        'section',
        { style: styles.wrap },
        h(
          'header',
          { style: styles.row },
          h('h3', { style: styles.h3 }, t.title),
          h('span', { style: styles.badge }, stateLabel),
          status && status.publicUrl
            ? h(
                'span',
                { style: { ...styles.hint, marginLeft: 'auto' } },
                t.publicUrl + ': ' + status.publicUrl,
                ' ',
                h('button', { style: styles.button, onClick: () => copy(status.publicUrl, 'url') }, copied === 'url' ? t.copied : t.copy),
              )
            : null,
        ),
        h('p', { style: styles.hint }, t.subtitle),
        status && status.message ? h('p', { style: styles.hint }, status.message) : null,
        missing.length > 0 ? h('p', { style: styles.error }, t.gate + ' ' + missing.join(', ')) : null,
        error ? h('p', { style: styles.error }, error) : null,
        notice ? h('p', { style: styles.hint }, notice) : null,

        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.h3 }, t.frps),
          field(t.serverAddr, form.serverAddr, (value) => setForm({ ...form, serverAddr: value })),
          field(t.serverPort, form.serverPort, (value) => setForm({ ...form, serverPort: value })),
          field(t.domain, form.domain, (value) => setForm({ ...form, domain: value })),
          field(t.publicBaseUrl, form.publicBaseUrl, (value) => setForm({ ...form, publicBaseUrl: value })),
          field(t.token, form.token, (value) => setForm({ ...form, token: value }), { type: 'password', autoComplete: 'off' }),
          h(
            'label',
            { style: styles.row },
            h('span', { style: styles.label }, t.useTls),
            h('input', { type: 'checkbox', checked: Boolean(form.useTLS), onChange: (event) => setForm({ ...form, useTLS: event.target.checked }) }),
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                style: styles.primary,
                disabled: busy,
                onClick: () =>
                  run(
                    'setFrpsConfig',
                    { serverAddr: form.serverAddr, serverPort: Number(form.serverPort), domain: form.domain, publicBaseUrl: form.publicBaseUrl, useTLS: form.useTLS },
                    (result) => {
                      setNotice(result && result.restartRequired ? t.restartHint : '');
                    },
                  ),
              },
              t.save,
            ),
            h('button', { style: styles.button, disabled: busy || !form.token, onClick: () => run('setFrpsToken', { token: form.token }) }, t.token),
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.h3 }, t.login),
          field(t.username, form.username, (value) => setForm({ ...form, username: value }), { autoComplete: 'username' }),
          field(t.password, form.password, (value) => setForm({ ...form, password: value }), { type: 'password', autoComplete: 'new-password' }),
          h('p', { style: styles.hint }, t.kickHint),
          h(
            'button',
            {
              style: styles.primary,
              disabled: busy || form.password.length < 12 || form.username.trim().length === 0,
              onClick: () => run('setLogin', { username: form.username, password: form.password }, () => setForm({ ...form, password: '' })),
            },
            t.setLogin,
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.h3 }, t.runtime),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.primary, disabled: busy || state === 'running', onClick: () => run('start', {}) }, t.start),
            h('button', { style: styles.button, disabled: busy || state !== 'running', onClick: () => run('stop', {}) }, t.stop),
            status && status.gatewayPort
              ? h('span', { style: styles.hint }, t.gatewayPort + ': 127.0.0.1:' + status.gatewayPort)
              : null,
            status && status.proxyState ? h('span', { style: styles.badge }, t.proxyState + ': ' + status.proxyState) : null,
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t.binary),
            h(
              'button',
              {
                style: styles.button,
                disabled: busy,
                onClick: async () => {
                  if (status && status.checksumAvailable === false) {
                    const ok = typeof confirm === 'function' ? confirm(t.confirmNoChecksum) : true;
                    if (!ok) return;
                    await run('confirmNoChecksum', {});
                  }
                  await run('chooseBinary', { mode: 'download' });
                },
              },
              t.binaryDownload,
            ),
            status && status.checksumAvailable === false ? h('span', { style: styles.badge }, t.noChecksum) : null,
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t.binaryPath),
            h('input', {
              style: styles.input,
              value: form.binaryPath,
              placeholder: t.binaryPathPlaceholder,
              onChange: (event) => setForm({ ...form, binaryPath: event.target.value }),
            }),
            h(
              'button',
              { style: styles.button, disabled: busy || !form.binaryPath, onClick: () => run('chooseBinary', { mode: 'path', path: form.binaryPath }) },
              t.binaryPath,
            ),
          ),
          status && status.downloadPct !== undefined
            ? h('p', { style: styles.hint }, t.state.downloading + ' ' + status.downloadPct + '%')
            : null,
          h('button', { style: styles.button, onClick: () => setShowLogs(!showLogs) }, showLogs ? t.hideLogs : t.showLogs),
          showLogs ? h('pre', { style: styles.code }, (status && status.logsTail ? status.logsTail : []).join('\n') || '—') : null,
        ),

        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.h3 }, t.security),
          h('p', { style: styles.hint }, t.securityBody),
          h('button', { style: styles.button, onClick: () => copy(NGINX_SNIPPET, 'nginx') }, copied === 'nginx' ? t.copied : t.nginx),
        ),
      );
    }

    return {
      name: NAMESPACE,
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const zh = MESSAGES.zh;
        const en = MESSAGES.en;
        let disposeDict = null;
        try {
          disposeDict = ctx.locale.register(NAMESPACE, { zh, 'zh-CN': zh, en });
        } catch {
          disposeDict = null;
        }
        const translate = () => {
          try {
            const active = ctx.locale.getLocale().active;
            return active && String(active).startsWith('zh') ? zh : en;
          } catch {
            return en;
          }
        };
        ctx.effect(() => {
          return () => {
            if (typeof disposeDict === 'function') disposeDict();
          };
        }, 'dsh-frp: locale dictionaries');

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: NAMESPACE,
              locale: NAMESPACE,
              inject: () => ({
                t: translate(),
                call: (endpoint, payload) => ctx.connection.rpc.call(PREFIX, endpoint, payload),
              }),
            },
            Panel,
          ),
        );
      },
    };
  },
});
