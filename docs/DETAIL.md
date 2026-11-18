# dsh-frp — 把本机 DSH 暴露到公网

本插件在你的 frps 上开一条 HTTP vhost 隧道，把本机 DSH Web GUI 发布到
`https://<你的域名>`。公网访客必须先过**插件自己的登录页**，之后所有请求由
插件网关转发给本机 GUI；DSH 的签名 Cookie 只在网关进程内存里，永远不下发到浏览器。

## 前提

- 自有 frps **≥ 0.52**，已启用 **token 认证**，并已开 `vhostHTTPPort`（常见 17002）。
- **不需要**配 `subdomainHost`：插件用 `customDomains`（完整域名）路由。
- 域名的 DNS 指向你的服务器；服务器上 nginx 做 HTTPS 终端。
- **17002 / 17003 端口只对 nginx 与本机可达**（防火墙或 docker 端口映射收窄）。
  否则存在绕开 nginx 的明文平行入口——这是最容易漏的一步。
- frp 版本对齐：插件钉 **0.72.0**（与 frps 同版最优；frp 官方兼容窗为 ±9 个 minor）。

## nginx 完整片段（必读）

默认 nginx 反代会 404 并掐断 WebSocket：未显式配置时 `Host` 被改写为
`$proxy_host`，且块内任一 `proxy_set_header` 会让默认头组整体失效。
按下面片段配置：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 443 ssl;
  server_name dsh.example.com;
  location / {
    proxy_pass http://127.0.0.1:17002;          # frps vhostHTTPPort（docker 映射地址）
    proxy_http_version 1.1;
    proxy_set_header Host $host;                  # 关键：保持公网域名（frps 按 Host 路由）
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $remote_addr;    # 覆写式：限速身份的权威来源
    proxy_set_header X-Forwarded-Proto $scheme;      # frps 会覆写为 http，仅日志用
    proxy_read_timeout 3600s; proxy_send_timeout 3600s;  # WS 空闲保活（默认 60s 会掐）
    client_max_body_size 50m;                     # 默认 1m 会挡上传
  }
}
```

注意 `X-Forwarded-For` 必须是**覆写式**（`$remote_addr`，不是 `$proxy_add_x_forwarded_for`）：
frps 会在其后追加它的直接对端，插件网关取倒数第二个条目作为访客真实 IP。

## 首次使用

1. 在 Plugins → **dsh-frp** 面板填 frps 参数：服务器地址、端口（如 17000）、公网域名、
   公网入口 URL（如 `https://dsh.example.com`）、frps token，保存。
   **保存会重新加载插件**以应用连接参数。
2. 选 frpc 二进制：
   - *自动下载*：按平台取官方 `frp_0.72.0_<os>_<arch>.tar.gz`，用插件内嵌 sha256 校验；
     失败即销毁并提示改用手动路径。GitHub 直连不可达时可在 Config 里把
     `frpc.downloadBaseUrl` 改成镜像前缀（必须 https）。
   - *手动路径*：填本机 frpc 绝对路径。
3. 设置公网登录用户名与密码（密码 **至少 12 位**）。改密码会立刻注销所有已登录设备。
4. 点「启动隧道」，状态变为 **运行中**，面板上的公网地址即可复制分享。

## 安全须知

- 这个入口等于**整机 Agent 的完全控制权**，包括本插件面板本身。请用强密码。
- 入口是**单用户视角**：所有登录者看到同一份 DSH 会话，没有并发隔离。
- 秘密（frps token、登录密码、会话签名密钥、frpc admin 口令）只存于凭据存储
  （或 `$DSH_HOME/dsh-frp/credentials.json`，权限 0600），从不写入 `cordis.patch.yml`。
- 登录失败采用**全局延迟递增**（1s 起指数上升，封顶 30s），不按 IP——本拓扑下
  网关的 TCP 对端恒为 127.0.0.1，按 IP 既形同虚设又能被用来做 DoS。
- 公网侧是否加密取决于你的 nginx；插件网关自身是明文 HTTP，只听 loopback。

## 调优与排错

- `vhostHTTPTimeout`（frps，默认 60s）是**响应头**超时：慢接口会 504。
- WebSocket 空闲断连几乎总是 nginx 的 `proxy_read_timeout`；按上面片段设为 3600s。
- 状态来自 frpc 的本地 admin API（`/healthz` + `/api/status`），不是解析 stdout。
- 「frpc 活但网关死」与「网关活但 DSH 死」是两种不同状态：前者访客会看到 frps 的错误页，
  后者会看到网关的 502 页面；网关一旦异常，插件会立即杀掉 frpc。
- 本地 link 安装的 bundle 改了 Host 侧 JS 需要**重启 Host**（HMR 只热 Client 半边）。
- macOS 上手动下载的 frpc 可能被 Gatekeeper 拦：

  ```bash
  xattr -d com.apple.quarantine /path/to/frpc
  ```

## 已知限制

- 只支持一个穿透目标（本机 DSH GUI），不做多代理管理。
- 不做公网侧 TLS 终端（交给 nginx）。
- 不支持 Windows 的 frpc zip 包（提取器只认 tar.gz）。
