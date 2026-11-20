/**
 * dsh-frp — Client half.
 *
 * A panel in the bundle config slot (Plugins → frp tunnel): tunnel status, frps
 * connection form, public login credentials, frpc runtime controls and logs.
 * It talks to the Host half through the plugin's own prefix route with a
 * one-shot RPC per action, and polls status while mounted.
 *
 * Two details shape this file:
 *
 *  - The Host never sends prose it expects a visitor to read: it sends
 *    `reason: {code, params}` and this panel owns the language (zh by default).
 *  - A Config save is persisted through the Host's config editor, which
 *    restarts the plugin entry to apply it. That restart unmounts this panel
 *    and can swallow the RPC answer, so the save intent and the resulting
 *    notice live in sessionStorage: whichever panel instance is mounted
 *    finishes the story instead of the user seeing nothing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-frp',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = 'dsh-frp';
    const PREFIX = '/dsh-frp';

    /** Panel notice and an in-flight save survive the plugin reload that applies it. */
    const STORE_NOTICE = 'dsh-frp:notice';
    const STORE_PENDING = 'dsh-frp:pending-save';
    const PENDING_TTL_MS = 120_000;
    const NOTICE_TTL_MS = 30 * 60_000;
    const SAVE_VERIFY_MS = 8000;

    const MESSAGES = {
      zh: {
        title: '公网穿透（frp）',
        subtitle: '经自有 frps 把本机 DSH 暴露到公网域名，入口先过本插件的登录页。',
        state: {
          'not-configured': '未配置',
          'need-binary': '缺少 frpc',
          downloading: '下载中',
          stopped: '已停止',
          starting: '启动中',
          running: '运行中',
          error: '错误',
        },
        reason: {
          'not-configured': '未配置：还缺 {missing}。',
          'need-binary': '缺少 frpc 二进制，请下载或指定本机路径。',
          downloading: '正在下载 frpc（{pct}%）。',
          'waiting-proxy': 'frpc 已连上服务器，正在等待 frps 登记代理…',
          'proxy-closed': '代理连接断开（{status}），正在重连…',
          'proxy-error': 'frps 拒绝了代理（{status}）：{detail}',
          'start-timeout': 'frpc 已启动，但 {seconds} 秒内代理仍未就绪；请检查 frps 认证 token、公网域名与端口。',
          'admin-unreachable': 'frpc 已启动，但管理接口暂时无响应，正在重试…',
          'frpc-exited': 'frpc 已退出（退出码 {exitCode}），{delayMs} 毫秒后自动重启。',
          'crash-loop': 'frpc 连续 {count} 次启动失败（最后一次退出码 {exitCode}），已停止重试；请展开日志排查服务器地址与 token。',
          'launch-failed': '启动 frpc 失败：{detail}',
          'binary-missing': '还没有可用的 frpc，请先下载或指定本机路径。',
        },
        missingLabels: {
          'login-username': '公网登录用户名',
          'login-password': '公网登录密码（至少 12 位）',
          'frps-server-addr': 'frps 服务器地址',
          'frps-domain': '公网域名',
          'public-base-url': '公网入口 URL',
          'frps-token': 'frps 认证 token',
        },
        fieldLabels: {
          serverAddr: '服务器地址',
          serverPort: '服务器端口',
          domain: '公网域名',
          publicBaseUrl: '公网入口 URL',
          username: '用户名',
          password: '密码',
          token: 'frps 认证 token',
          binaryPath: 'frpc 路径',
        },
        proxyStates: {
          running: '运行中',
          'start error': '启动失败',
          'login fail': '登录失败',
          'waiting start': '等待启动',
          new: '新建',
          closed: '已关闭',
        },
        errors: {
          'start-gate': '还有启动条件未满足。',
          'password-too-short': '密码至少需要 {min} 位。',
          'empty-field': '{field}不能为空。',
          'invalid-text': '{field}不能包含换行。',
          'invalid-domain': '公网域名格式不正确（示例：dsh.example.com）。',
          'invalid-port': '端口必须是 1–65535 之间的整数。',
          'invalid-url': '公网入口 URL 必须 http(s) 开头、不带路径。',
          'invalid-mode': '无法识别的二进制模式。',
          'invalid-auto-start': '自动启动只能是开或关。',
          'no-checksum': '该 frpc 版本没有内嵌 sha256，无法校验下载内容。',
          'request-failed': '插件拒绝了这次操作。',
        },
        savedWhat: { frps: 'frps 连接配置', token: 'frps 认证 token', login: '公网登录凭据', binary: 'frpc 二进制设置', autoStart: '自动启动设置' },
        saving: '正在保存，插件会重新加载以应用配置…',
        saveOk: '✅ 已保存：{what}。',
        saveFailed: '❌ 保存失败：{reason}',
        saveUnconfirmed: '⚠️ 已提交保存，但插件重载中断了回执：若下方数值已更新即保存生效，否则请再点一次保存。',
        needPrereq: '下一步：先补齐 {missing}。',
        needPrereqShort: '还缺：{missing}',
        needBinaryNext: '下一步：先准备 frpc（点「自动下载」或填写本机路径）。',
        needStart: '下一步：点「启动隧道」。',
        needStopStart: '下一步：新连接参数需「停止隧道」再「启动隧道」才生效（隧道正在运行）。',
        prereq: '启动条件',
        dismiss: '关闭提示',
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
        autoStart: '随 DSH 重启自动恢复隧道',
        autoStartHint: '勾选后，DSH 重启会自动拉起隧道（启动条件仍需满足）。勾选或取消会立即重载插件：勾选即现在启动，取消即现在断开。',
        token: 'frps 认证 token',
        save: '保存',
        saveToken: '保存 token',
        restartHint: '有改动时插件会重新加载以应用配置，页面短暂刷新属于正常现象。',
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
        gatewayDown: '网关已停止监听，隧道无法工作；请重载插件',
        download: '下载 frpc',
        downloading: '下载中',
        noticeJoin: '',
        listSeparator: '、',
      },
      en: {
        title: 'frp tunnel',
        subtitle: 'Expose this DSH through your own frps domain. Visitors sign in to this plugin first.',
        state: {
          'not-configured': 'Not configured',
          'need-binary': 'frpc missing',
          downloading: 'Downloading',
          stopped: 'Stopped',
          starting: 'Starting',
          running: 'Running',
          error: 'Error',
        },
        reason: {
          'not-configured': 'Not configured: still missing {missing}.',
          'need-binary': 'No frpc binary yet; download one or point at a local path.',
          downloading: 'Downloading frpc ({pct}%).',
          'waiting-proxy': 'frpc is connected; waiting for frps to register the proxy…',
          'proxy-closed': 'The proxy dropped ({status}); reconnecting…',
          'proxy-error': 'frps rejected the proxy ({status}): {detail}',
          'start-timeout': 'frpc is running but its proxy did not come up within {seconds}s; check the frps token, domain and port.',
          'admin-unreachable': 'frpc is running but its admin API is not answering; retrying…',
          'frpc-exited': 'frpc exited (code {exitCode}); restarting in {delayMs}ms.',
          'crash-loop': 'frpc failed {count} times in a row (last exit code {exitCode}) and stopped retrying; open the logs to check the server address and token.',
          'launch-failed': 'Could not launch frpc: {detail}',
          'binary-missing': 'No frpc binary is available; download one or point at a local path.',
        },
        missingLabels: {
          'login-username': 'public sign-in username',
          'login-password': 'public sign-in password (12+ characters)',
          'frps-server-addr': 'frps server address',
          'frps-domain': 'public domain',
          'public-base-url': 'public entrance URL',
          'frps-token': 'frps auth token',
        },
        fieldLabels: {
          serverAddr: 'server address',
          serverPort: 'server port',
          domain: 'public domain',
          publicBaseUrl: 'public entrance URL',
          username: 'username',
          password: 'password',
          token: 'frps auth token',
          binaryPath: 'frpc path',
        },
        proxyStates: {
          running: 'running',
          'start error': 'start error',
          'login fail': 'login failed',
          'waiting start': 'waiting to start',
          new: 'new',
          closed: 'closed',
        },
        errors: {
          'start-gate': 'Some start prerequisites are still missing.',
          'password-too-short': 'The password needs at least {min} characters.',
          'empty-field': '{field} must not be empty.',
          'invalid-text': '{field} must not contain a newline.',
          'invalid-domain': 'That is not a plain domain name (for example dsh.example.com).',
          'invalid-port': 'The port must be an integer between 1 and 65535.',
          'invalid-url': 'The public entrance URL must be http(s) and have no path.',
          'invalid-mode': 'Unknown binary mode.',
          'invalid-auto-start': 'Auto-start must be true or false.',
          'no-checksum': 'This frpc version has no embedded sha256, so the download cannot be verified.',
          'request-failed': 'The plugin refused this action.',
        },
        savedWhat: { frps: 'frps connection settings', token: 'frps auth token', login: 'public sign-in credentials', binary: 'frpc binary settings', autoStart: 'auto-start setting' },
        saving: 'Saving; the plugin reloads to apply the change…',
        saveOk: '✅ Saved: {what}.',
        saveFailed: '❌ Save failed: {reason}',
        saveUnconfirmed: '⚠️ Submitted, but the plugin reload cut the answer short: if the values below are updated the save applied, otherwise save once more.',
        needPrereq: 'Next: fill in {missing}.',
        needPrereqShort: 'still missing: {missing}',
        needBinaryNext: 'Next: get frpc first (download it or point at a local path).',
        needStart: 'Next: click “Start tunnel”.',
        needStopStart: 'Next: stop the tunnel and start it again so the new connection settings apply (it is running now).',
        prereq: 'Start prerequisites',
        dismiss: 'Dismiss',
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
        autoStart: 'Resume the tunnel when DSH restarts',
        autoStartHint: 'When checked, a DSH restart brings the tunnel back, provided the start prerequisites still hold. Toggling reloads the plugin: checking starts the tunnel now, unchecking disconnects it now.',
        token: 'frps auth token',
        save: 'Save',
        saveToken: 'Save token',
        restartHint: 'A change reloads the plugin to apply it; a brief refresh is expected.',
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
        gatewayDown: 'The gateway stopped listening, so the tunnel cannot work. Reload the plugin.',
        download: 'Download frpc',
        downloading: 'Downloading',
        noticeJoin: ' ',
        listSeparator: ', ',
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

    /** The tunnel can be stopped while it is up, starting, or stuck in error. */
    const canStop = (state) => state === 'running' || state === 'starting' || state === 'error' || state === 'downloading';

    /**
     * The auto-start box shows the persisted value, never local state: the
     * control saves on click, so a refused save must not leave a tick behind.
     * A Host too old to send the field, or a first render before status
     * arrives, reads as off rather than guessing.
     */
    const autoStartChecked = (status) => Boolean(status?.autoStart);

    /** A dead gateway is its own state: the tunnel is not merely "stopped". */
    const gatewayWarning = (status, t) => {
      if (!status || status.gateway !== 'error') return undefined;
      return (t.gatewayDown ?? 'Gateway is down') + (status.gatewayMessage ? ': ' + status.gatewayMessage : '');
    };

    /** A download needs explicit consent when the pinned version has no hash. */
    const needsChecksumConsent = (status) => Boolean(status) && status.checksumAvailable === false;

    /**
     * Unwrap one Connection RPC result.
     *
     * `connection.rpc.call` resolves with the result envelope — {ok:true,value}
     * or {ok:false,error} — and never with the bare payload. A panel that reads
     * the envelope as if it were the payload shows empty fields and drops every
     * failure, which is exactly how "saved" configuration went missing.
     *
     * A failure marked `hostRejected` is the Host's own verdict (validation, a
     * start gate): it is final. A transport failure is not, because saving
     * restarts the Host half and can cut the answer off mid-flight.
     */
    const unwrapRpcResult = (result, endpoint) => {
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        throw new TypeError('dsh-frp: malformed rpc result for ' + String(endpoint));
      }
      if (!result.ok) {
        const failure = result.error && typeof result.error === 'object' ? result.error : {};
        const error = new Error(String(failure.message ?? 'panel request failed'));
        error.code = typeof failure.code === 'string' ? failure.code : 'request-failed';
        error.details = failure.details && typeof failure.details === 'object' ? failure.details : {};
        error.hostRejected = true;
        throw error;
      }
      return result.value;
    };

    /** Fill one `{name}` template; an unknown value shows as an em dash. */
    const format = (template, params) =>
      String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
        const value = params?.[key];
        return value === undefined || value === null || value === '' ? '—' : String(value);
      });

    /** Render a gate token list ("login-password", …) as localized labels. */
    const missingText = (missing, t) => {
      const list = Array.isArray(missing) ? missing : [];
      if (list.length === 0) return '';
      return list.map((token) => t.missingLabels?.[token] ?? token).join(t.listSeparator ?? ', ');
    };

    /** The status line: the Host's reason code rendered in the panel language. */
    const statusText = (status, t) => {
      if (!status) return '';
      const reason = status.reason;
      if (reason && typeof reason.code === 'string') {
        const template = t.reason?.[reason.code];
        if (template) {
          const params = { ...(reason.params ?? {}) };
          if (reason.code === 'not-configured') params.missing = missingText(params.missing, t);
          return format(template, params);
        }
      }
      return status.message ?? '';
    };

    const describeError = (error, t) => {
      if (!error) return String(t.errors?.['request-failed'] ?? 'request failed');
      const missing = error.details?.missing;
      if (Array.isArray(missing) && missing.length > 0) {
        return format(t.needPrereqShort, { missing: missingText(missing, t) });
      }
      const template = error.code ? t.errors?.[error.code] : undefined;
      if (template) {
        const params = { ...(error.details ?? {}) };
        if (params.field !== undefined) params.field = t.fieldLabels?.[params.field] ?? params.field;
        return format(template, params);
      }
      return String(error.message ?? error);
    };

    /** The "what do I still have to do" half of a save confirmation. */
    const nextStepPart = (status, t) => {
      const missing = status?.missing ?? [];
      if (missing.length > 0) return { key: 'needPrereq', params: { missing: missingText(missing, t) } };
      if (!status?.binaryPath) return { key: 'needBinaryNext' };
      if (status.state === 'running' || status.state === 'starting') return { key: 'needStopStart' };
      return { key: 'needStart' };
    };

    /** The live "what is left to do" clause; nothing to say without a status. */
    const nextStepText = (status, t) => {
      if (!status) return '';
      const part = nextStepPart(status, t);
      return format(t[part.key] ?? part.key, part.params);
    };

    /**
     * Render a notice. A `{next:true}` part is resolved against the status on
     * screen, not the status at save time: the reload that applies a save also
     * stops the tunnel, and a stale "it is running now" line would contradict
     * the badge right above it.
     */
    const noticeText = (notice, t, status) => {
      if (!notice || !Array.isArray(notice.parts)) return '';
      return notice.parts
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (part.next === true) return nextStepText(status, t);
          if (typeof part.key !== 'string') return '';
          return format(t[part.key] ?? part.key, part.params);
        })
        .filter((text) => text.length > 0)
        .join(t.noticeJoin ?? ' ');
    };

    /** Does a fresh status show the values the save asked for? */
    const satisfies = (status, expected) => {
      if (!status || !expected || typeof expected !== 'object') return false;
      if (expected.serverAddr !== undefined && String(status.serverAddr ?? '') !== expected.serverAddr) return false;
      if (expected.serverPort !== undefined && Number(status.serverPort) !== Number(expected.serverPort)) return false;
      if (expected.domain !== undefined && String(status.domain ?? '').toLowerCase() !== String(expected.domain).toLowerCase()) return false;
      if (expected.publicUrl !== undefined && String(status.publicUrl ?? '') !== expected.publicUrl) return false;
      if (expected.username !== undefined && String(status.username ?? '') !== expected.username) return false;
      if (expected.configuredBinaryPath !== undefined && String(status.configuredBinaryPath ?? '') !== expected.configuredBinaryPath) return false;
      if (expected.hasFrpsToken !== undefined && Boolean(status.hasFrpsToken) !== expected.hasFrpsToken) return false;
      if (expected.hasLoginPassword !== undefined && Boolean(status.hasLoginPassword) !== expected.hasLoginPassword) return false;
      if (expected.autoStart !== undefined && Boolean(status.autoStart) !== expected.autoStart) return false;
      return true;
    };

    /** What the status must show once a setFrpsConfig save lands. */
    const frpsExpectation = (payload) => {
      const expected = {};
      if (payload?.serverAddr !== undefined) expected.serverAddr = String(payload.serverAddr).trim();
      if (payload?.serverPort !== undefined) expected.serverPort = Number(payload.serverPort);
      if (payload?.domain !== undefined) expected.domain = String(payload.domain).trim().toLowerCase();
      if (payload?.publicBaseUrl !== undefined) {
        try {
          expected.publicUrl = new URL(String(payload.publicBaseUrl).trim()).origin;
        } catch {
          /* an unusable URL is rejected by the Host; nothing to wait for */
        }
      }
      return expected;
    };

    // --- panel-local storage -------------------------------------------------
    // Saving restarts the plugin entry, which unmounts this panel. Keeping the
    // notice and the pending expectation outside React is what lets the panel
    // that comes back report the result instead of silently redrawing.
    const storage = () => {
      try {
        return globalThis.window?.sessionStorage;
      } catch {
        return undefined;
      }
    };

    const readStore = (key) => {
      try {
        const raw = storage()?.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    };

    const writeStore = (key, value) => {
      try {
        const store = storage();
        if (!store) return;
        if (value === undefined) store.removeItem(key);
        else store.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode or no storage: notices simply do not persist */
      }
    };

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
      notice: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        fontSize: '12px',
        lineHeight: 1.6,
        margin: 0,
        padding: '9px 11px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
      },
      noticeOk: {
        color: 'var(--dsw-alias-text-success, #2fbf71)',
        borderColor: 'var(--dsw-alias-text-success, #2fbf71)',
        background: 'color-mix(in srgb, var(--dsw-alias-text-success, #2fbf71) 10%, transparent)',
      },
      noticeError: {
        color: 'var(--dsw-alias-text-danger, #ff6b6b)',
        borderColor: 'var(--dsw-alias-text-danger, #ff6b6b)',
        background: 'color-mix(in srgb, var(--dsw-alias-text-danger, #ff6b6b) 10%, transparent)',
      },
      noticeInfo: {
        color: 'var(--dsw-alias-text-primary, inherit)',
        opacity: 0.9,
      },
      dismiss: {
        marginLeft: 'auto',
        border: '0',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '14px',
        lineHeight: 1,
        padding: '0 2px',
        opacity: 0.65,
      },
      chip: {
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        whiteSpace: 'nowrap',
      },
      chipOk: { color: 'var(--dsw-alias-text-success, #2fbf71)', borderColor: 'var(--dsw-alias-text-success, #2fbf71)' },
      chipMissing: { color: 'var(--dsw-alias-text-danger, #ff6b6b)', borderColor: 'var(--dsw-alias-text-danger, #ff6b6b)', opacity: 0.85 },
    };

    const badgeStyleOf = (state) => {
      if (state === 'running') return { ...styles.badge, color: 'var(--dsw-alias-text-success, #2fbf71)' };
      if (state === 'error') return { ...styles.badge, color: 'var(--dsw-alias-text-danger, #ff6b6b)' };
      if (state === 'starting' || state === 'downloading') return { ...styles.badge, color: 'var(--dsw-alias-accent, #4c8dff)' };
      return styles.badge;
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

    const GATE_TOKENS = ['login-username', 'login-password', 'frps-server-addr', 'frps-domain', 'public-base-url', 'frps-token'];

    // The newest connection-bound caller in this page. A save can outlive the
    // panel instance that started it (the plugin reloads to apply it), so the
    // in-flight verification must always speak through the live binding.
    let liveCall;

    function Panel(props) {
      const t = props.t;
      const call = props.call;
      const invoke = (endpoint, payload) => (typeof liveCall === 'function' ? liveCall : call)(endpoint, payload);
      const [status, setStatus] = React.useState(undefined);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState(() => {
        const stored = readStore(STORE_NOTICE);
        // A stale banner from yesterday is noise, and a replayed refusal looks
        // like a fresh failure; only a recent positive result is worth showing.
        if (!stored || stored.tone === 'error' || typeof stored.at !== 'number') return undefined;
        if (Date.now() - stored.at > NOTICE_TTL_MS) return undefined;
        return stored;
      });
      const [busy, setBusy] = React.useState(false);
      const [showLogs, setShowLogs] = React.useState(false);
      const [copied, setCopied] = React.useState('');
      const [form, setForm] = React.useState({ serverAddr: '', serverPort: '', domain: '', publicBaseUrl: '', useTLS: true, token: '', username: '', password: '', binaryPath: '' });
      const [seeded, setSeeded] = React.useState(false);

      const announce = (next) => {
        setNotice(next);
        // A refusal is shown where it happened and never replayed: the reload
        // path does not follow a rejection, so there is nothing to recover.
        if (next && next.tone === 'error') {
          writeStore(STORE_NOTICE, undefined);
          return;
        }
        writeStore(STORE_NOTICE, next === undefined ? undefined : { ...next, at: Date.now() });
      };

      /** Pull status until `predicate` holds, tolerating the reload window. */
      const waitForStatus = async (predicate, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          try {
            // invoke() reads the live connection binding, so a save that
            // outlives this panel instance still talks to the reloaded Host.
            const next = await invoke('status', {});
            if (predicate(next)) return next;
          } catch {
            /* the Host half is restarting to apply the save */
          }
          if (Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      };

      React.useEffect(() => {
        let alive = true;
        const pull = async () => {
          try {
            const next = await invoke('status', {});
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
      }, []);

      // Finish a save whose answer was cut off by the reload that applied it.
      // The pending expectation was written before the RPC, so the panel that
      // comes back after the reload can verify it instead of showing nothing.
      React.useEffect(() => {
        const pending = readStore(STORE_PENDING);
        if (!pending || typeof pending.at !== 'number' || Date.now() - pending.at > PENDING_TTL_MS) return undefined;
        let alive = true;
        void (async () => {
          const fresh = await waitForStatus((next) => satisfies(next, pending.expect), SAVE_VERIFY_MS);
          if (!alive) return;
          writeStore(STORE_PENDING, undefined);
          if (fresh) {
            setStatus(fresh);
            announce({
              tone: 'ok',
              parts: [{ key: 'saveOk', params: { what: t.savedWhat?.[pending.what] ?? pending.what } }, { next: true }],
            });
          } else {
            announce({ tone: 'info', parts: [{ key: 'saveUnconfirmed' }] });
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

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
          binaryPath: status.configuredBinaryPath ?? '',
        }));
        setSeeded(true);
      }, [status, seeded]);

      const run = async (endpoint, payload, done) => {
        setBusy(true);
        setError('');
        try {
          const result = await invoke(endpoint, payload ?? {});
          if (typeof done === 'function') done(result);
          const next = await invoke('status', {});
          setStatus(next);
          return true;
        } catch (reason) {
          setError(describeError(reason, t));
          return false;
        } finally {
          setBusy(false);
        }
      };

      /**
       * Save one settings group and report the outcome.
       *
       * The save is written through the Host's config editor, which restarts
       * the plugin to apply it. So the outcome is decided by what the Host
       * reports afterwards, not by the RPC alone: a transport failure is not a
       * failed save, and a Host rejection is never a successful one.
       */
      const save = async (endpoint, payload, options) => {
        const what = options?.what ?? endpoint;
        const expected = options?.expect ?? {};
        setBusy(true);
        setError('');
        writeStore(STORE_PENDING, { endpoint, what, expect: expected, at: Date.now() });
        announce({ tone: 'info', parts: [{ key: 'saving' }] });

        let failure;
        let result;
        try {
          result = await invoke(endpoint, payload ?? {});
        } catch (reason) {
          failure = reason;
        }

        if (failure && failure.hostRejected) {
          writeStore(STORE_PENDING, undefined);
          announce({ tone: 'error', parts: [{ key: 'saveFailed', params: { reason: describeError(failure, t) } }] });
          setBusy(false);
          return;
        }

        const fresh = await waitForStatus((next) => satisfies(next, expected), SAVE_VERIFY_MS);
        writeStore(STORE_PENDING, undefined);
        if (fresh) {
          setStatus(fresh);
          announce({
            tone: 'ok',
            parts: [{ key: 'saveOk', params: { what: t.savedWhat?.[what] ?? what } }, { next: true }],
          });
          if (typeof options?.onSaved === 'function') options.onSaved(result);
        } else if (result || failure) {
          announce({ tone: 'info', parts: [{ key: 'saveUnconfirmed' }] });
        } else {
          announce({ tone: 'info', parts: [{ key: 'saveUnconfirmed' }] });
        }
        setBusy(false);
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
      const proxyStateLabel = status && status.proxyState ? (t.proxyStates?.[String(status.proxyState).toLowerCase()] ?? status.proxyState) : undefined;
      const statusLine = statusText(status, t);
      const gatewayText = gatewayWarning(status, t);

      return h(
        'section',
        { style: styles.wrap },
        h(
          'header',
          { style: styles.row },
          h('h3', { style: styles.h3 }, t.title),
          h('span', { style: badgeStyleOf(state) }, stateLabel),
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
        notice
          ? h(
              'div',
              {
                style: {
                  ...styles.notice,
                  ...(notice.tone === 'ok' ? styles.noticeOk : notice.tone === 'error' ? styles.noticeError : styles.noticeInfo),
                },
                role: 'status',
              },
              h('span', {}, noticeText(notice, t, status)),
              h('button', { style: styles.dismiss, title: t.dismiss, 'aria-label': t.dismiss, onClick: () => announce(undefined) }, '×'),
            )
          : null,
        statusLine ? h('p', { style: styles.hint }, statusLine) : null,
        gatewayText ? h('p', { style: styles.error }, gatewayText) : null,
        error ? h('p', { style: styles.error }, error) : null,

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
                onClick: () => {
                  const payload = { serverAddr: form.serverAddr, serverPort: Number(form.serverPort), domain: form.domain, publicBaseUrl: form.publicBaseUrl, useTLS: form.useTLS };
                  void save('setFrpsConfig', payload, { what: 'frps', expect: frpsExpectation(payload) });
                },
              },
              t.save,
            ),
            h(
              'button',
              {
                style: styles.button,
                disabled: busy || !form.token,
                onClick: () =>
                  void save(
                    'setFrpsToken',
                    { token: form.token },
                    {
                      what: 'token',
                      expect: { hasFrpsToken: true },
                      onSaved: () => setForm((current) => ({ ...current, token: '' })),
                    },
                  ),
              },
              t.saveToken,
            ),
            h('span', { style: styles.hint }, t.restartHint),
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
              onClick: () =>
                void save(
                  'setLogin',
                  { username: form.username, password: form.password },
                  {
                    what: 'login',
                    expect: { username: form.username.trim(), hasLoginPassword: true },
                    onSaved: () => setForm((current) => ({ ...current, password: '' })),
                  },
                ),
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
            h('span', { style: styles.label }, t.prereq),
            ...GATE_TOKENS.map((token) => {
              const ok = !missing.includes(token);
              return h(
                'span',
                { style: { ...styles.chip, ...(ok ? styles.chipOk : styles.chipMissing) }, key: token },
                (ok ? '✓ ' : '✗ ') + (t.missingLabels?.[token] ?? token),
              );
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.primary, disabled: busy || state === 'running', onClick: () => void run('start', {}) }, t.start),
            h('button', { style: styles.button, disabled: busy || !canStop(state), onClick: () => void run('stop', {}) }, t.stop),
            status && status.gatewayPort
              ? h('span', { style: styles.hint }, t.gatewayPort + ': 127.0.0.1:' + status.gatewayPort)
              : null,
            proxyStateLabel ? h('span', { style: styles.badge }, t.proxyState + ': ' + proxyStateLabel) : null,
          ),
          // A policy, not a second start button: it says when the tunnel comes
          // back, and the hint has to admit that saving it reloads the plugin
          // and therefore starts or stops the tunnel right now.
          h(
            'label',
            { style: styles.row },
            h('span', { style: styles.label }, t.autoStart),
            h('input', {
              type: 'checkbox',
              checked: autoStartChecked(status),
              disabled: busy,
              onChange: (event) => {
                const next = event.target.checked;
                void save('setAutoStart', { autoStart: next }, { what: 'autoStart', expect: { autoStart: next } });
              },
            }),
          ),
          h('p', { style: styles.hint }, t.autoStartHint),
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
                  let allowNoChecksum = false;
                  if (needsChecksumConsent(status)) {
                    const ok = typeof confirm === 'function' ? confirm(t.confirmNoChecksum) : true;
                    if (!ok) return;
                    allowNoChecksum = true;
                  }
                  // Ask the Host to fetch the binary right now: the download
                  // must not wait for the next Start, and a no-checksum refusal
                  // is answered by consenting and retrying in the same click.
                  const downloaded = await run('download', { allowNoChecksum });
                  if (downloaded) await save('chooseBinary', { mode: 'download' }, { what: 'binary', expect: { configuredBinaryPath: '' } });
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
              {
                style: styles.button,
                disabled: busy || !form.binaryPath,
                onClick: () => void save('chooseBinary', { mode: 'path', path: form.binaryPath }, { what: 'binary', expect: { configuredBinaryPath: form.binaryPath.trim() } }),
              },
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
      canStop,
      autoStartChecked,
      gatewayWarning,
      needsChecksumConsent,
      unwrapRpcResult,
      statusText,
      missingText,
      describeError,
      noticeText,
      satisfies,
      nginxSnippet: NGINX_SNIPPET,
      messages: MESSAGES,
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
              inject: () => {
                // Connection answers {ok, value} / {ok:false, error}; the panel
                // wants the payload, and a refused action must reject so run()
                // reports it instead of pretending the save went through.
                const call = async (endpoint, payload) =>
                  unwrapRpcResult(await ctx.connection.rpc.call(PREFIX, endpoint, payload), endpoint);
                liveCall = call;
                return { t: translate(), call };
              },
            },
            Panel,
          ),
        );
      },
    };
  },
});
