#!/usr/bin/env node
// A stand-in for frpc used by the manager tests: it reads the TOML the
// manager wrote, serves the admin API on the configured port, and can be told
// through the environment to fail in specific ways.
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const tomlPath = args[args.indexOf('-c') + 1];
const toml = fs.readFileSync(tomlPath, 'utf8');
const value = (key) => {
  const match = toml.match(new RegExp('^' + key.replace(/\./g, '\\.') + ' = "([^"]*)"$', 'm'));
  return match ? match[1] : undefined;
};
const number = (key) => {
  const match = toml.match(new RegExp('^' + key.replace(/\./g, '\\.') + ' = (\\d+)$', 'm'));
  return match ? Number(match[1]) : undefined;
};

const adminPort = number('webServer.port');
const adminUser = value('webServer.user');
const adminPassword = value('webServer.password');
const proxyName = value('name');
const localPort = number('localPort');

const log = (line) => process.stdout.write('stub-frpc ' + line + '\n');

if (process.env.STUB_FAST_EXIT === '1') {
  process.stderr.write('stub-frpc login failed\n');
  process.exit(7);
}

if (process.env.STUB_DESCRIBE === '1') {
  log('adminPort=' + adminPort + ' user=' + adminUser + ' pass=' + adminPassword + ' proxy=' + proxyName + ' localPort=' + localPort);
}

const delay = Number(process.env.STUB_SLOW_MS ?? 0);
setTimeout(() => {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/api/status') {
      const auth = req.headers.authorization ?? '';
      const expected = 'Basic ' + Buffer.from(adminUser + ':' + adminPassword).toString('base64');
      if (auth !== expected) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      const body = JSON.stringify({ clientCount: 1, proxies: [{ name: proxyName, status: 'running', type: 'http', local_addr: '127.0.0.1:' + localPort }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  server.listen(adminPort, '127.0.0.1', () => log('admin listening on ' + adminPort));
}, delay);

setInterval(() => log('tick'), 60).unref();

if (process.env.STUB_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(0), Number(process.env.STUB_EXIT_AFTER_MS));
}
