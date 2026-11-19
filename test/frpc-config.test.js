import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRP_VERSION,
  tomlString,
  randomProxyNameSuffix,
  renderFrpcToml,
} from '../src/frpc-config.js';

const base = {
  serverAddr: 'frp.example.com',
  serverPort: 17000,
  authToken: 'secret-token',
  useTls: true,
  domain: 'dsh.example.com',
  localPort: 51234,
  adminPort: 51235,
  adminUser: 'adminuser',
  adminPassword: 'adminpass',
  proxyName: 'dsh-frp-ab12cd',
};

test('FRP_VERSION pins 0.72.0', () => {
  assert.equal(FRP_VERSION, '0.72.0');
});

test('TOML keeps the pinned top-level structure', () => {
  const toml = renderFrpcToml({ ...base, useTls: false });
  assert.ok(toml.includes('serverAddr = "frp.example.com"'));
  assert.ok(toml.includes('serverPort = 17000'));
  assert.ok(toml.includes('auth.token = "secret-token"'));
  assert.ok(toml.includes('transport.tls.enable = false'));
  assert.ok(toml.includes('loginFailExit = false'));
  assert.ok(toml.includes('webServer.addr = "127.0.0.1"'));
  assert.ok(toml.includes('webServer.port = 51235'));
  assert.ok(toml.includes('webServer.user = "adminuser"'));
  assert.ok(toml.includes('webServer.password = "adminpass"'));
});

test('transport.tls.enable is written explicitly for both branches', () => {
  assert.ok(renderFrpcToml({ ...base, useTls: true }).includes('transport.tls.enable = true'));
  assert.ok(renderFrpcToml({ ...base, useTls: false }).includes('transport.tls.enable = false'));
});

test('proxy block carries customDomains, localPort, healthCheck and a random-suffixed name', () => {
  const toml = renderFrpcToml(base);
  assert.ok(toml.includes('[[proxies]]'));
  assert.ok(toml.includes('type = "http"'));
  assert.ok(toml.includes('customDomains = ["dsh.example.com"]'));
  assert.ok(toml.includes('name = "dsh-frp-ab12cd"'));
  assert.ok(toml.includes('localIP = "127.0.0.1"'));
  assert.ok(toml.includes('localPort = 51234'));
  assert.ok(toml.includes('healthCheck.type = "tcp"'));
});

test('tomlString escapes quotes, backslashes and control characters including newline', () => {
  assert.equal(tomlString('a"b'), '"a\\"b"');
  assert.equal(tomlString('a\\b'), '"a\\\\b"');
  assert.equal(tomlString('a\nb'), '"a\\u000ab"');
  assert.equal(tomlString('a\tb'), '"a\\u0009b"');
  assert.equal(tomlString('a\u0000b'), '"a\\u0000b"');
});

test('tomlString newline escape cannot inject a new TOML line', () => {
  const rendered = tomlString('x\nloginFailExit = true');
  assert.ok(!rendered.includes('\n'), 'escaped string must not contain a raw newline');
});

test('randomProxyNameSuffix is 6 lowercase hex chars and random', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const suffix = randomProxyNameSuffix();
    assert.match(suffix, /^[0-9a-f]{6}$/);
    seen.add(suffix);
  }
  assert.ok(seen.size > 40, 'suffixes should differ across calls');
});
