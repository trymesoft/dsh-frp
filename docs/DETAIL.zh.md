# dsh-frp — 把本机 DSH 发布到自有 frps

![服务器经 frp 隧道与鉴权网关到达笔记本上的 DSH](preview.svg)

`dsh-frp` 把本机 DSH Web GUI 发布到你自己的域名上。插件在 DSH 进程内托管 `frpc`、生成其配置，
并在隧道前加一个登录网关：访客必须先登录，才能触达任何 DSH 内容；DSH 的签名 Cookie 始终留在
Host 进程内，不会下发给浏览器。

## 前提

- 与钉定的 frpc 0.72.0 保证兼容的是 **frps 0.64–0.80**（实测 0.72.0）。TOML 自 0.52 起支持，
  更老的版本尽力而为。需启用 token 认证与 `vhostHTTPPort`；插件用 `customDomains` 路由，
  **不需要** `subdomainHost`。
- 一个 DNS 指向 frps 主机的**域名**。
- vhost 端口前的 **HTTPS 反向代理**。默认配置会 404 并掐断 WebSocket，请使用下面的 nginx 片段：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 443 ssl;
  server_name dsh.example.com;
  location / {
    proxy_pass http://127.0.0.1:17002;              # frps vhostHTTPPort
    proxy_http_version 1.1;
    proxy_set_header Host $host;                    # 必须：frps 按 Host 路由
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $remote_addr;  # 覆写式，不要追加
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 50m;
  }
}
```

- 防火墙规则：`vhostHTTPPort`（17002）与 `vhostHTTPSPort`（17003）只允许 nginx 与本机访问。

## 使用

1. 打开 **插件 → 公网穿透（frp）**。
2. 填写 frps 地址、端口、公网域名与公网入口 URL（`https://dsh.example.com`），并保存 frps token。
3. 准备 `frpc`：点 **自动下载**（校验 SHA-256），或填写本机二进制的绝对路径。
4. 设置**公网登录**用户名，以及至少 12 位的密码。
5. 点 **启动隧道**；状态变为 **运行中** 后即可复制公网地址。

DSH 重启后，只要启动条件仍满足，`autoStart` 会恢复隧道。开关在 **frpc 运行** 卡片上；勾选或取消
会重载插件，也就是当场启动或断开隧道，而不是等下次重启才生效。

## 安全

这个入口等同于这台机器上 DSH Agent 的权限，包括本面板。请使用足够长的随机密码，保持 vhost
端口对公网关闭，并在反向代理上终结 TLS。入口是**单用户视角**：所有访客看到同一份 DSH 会话，
没有按用户隔离。修改密码会立即注销所有已登录设备。

## 限制

- 只穿透一个目标（本机 DSH GUI）；不做多代理、多域名管理。
- 插件不做公网侧 TLS 终端；那属于反向代理。
- 自动下载只支持 `tar.gz` 发布包；Windows 需手动提供 `frpc.exe`。
- 没有多用户账号与审计日志。

完整指南、配置参考与排错表见 [README.zh-CN.md](../README.zh-CN.md)。
