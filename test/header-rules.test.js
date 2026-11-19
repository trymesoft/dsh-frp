import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHopByHop,
  hasFramingConflict,
  clientIpFromXff,
  normalizeRequestHeaders,
  rewriteResponseHeaders,
  rewriteLocation,
  parseRequestTarget,
} from '../src/header-rules.js';

test('stripHopByHop drops the fixed list, Connection-named headers and Proxy-Connection', () => {
  const out = stripHopByHop({
    connection: 'keep-alive, X-Foo',
    'x-foo': '1',
    accept: '*/*',
    'keep-alive': 'timeout=5',
    'proxy-connection': 'keep-alive',
    te: 'trailers',
    trailer: 'x-t',
    upgrade: 'websocket',
    'transfer-encoding': 'chunked',
  });
  assert.deepEqual(out, { accept: '*/*' });
});

test('stripHopByHop leaves end-to-end headers alone', () => {
  const out = stripHopByHop({ 'sec-websocket-key': 'abc', 'sec-websocket-version': '13', 'content-type': 'text/plain' });
  assert.deepEqual(out, { 'sec-websocket-key': 'abc', 'sec-websocket-version': '13', 'content-type': 'text/plain' });
});

test('hasFramingConflict detects Transfer-Encoding plus Content-Length', () => {
  assert.equal(hasFramingConflict({ 'transfer-encoding': 'chunked', 'content-length': '5' }), true);
  assert.equal(hasFramingConflict({ 'transfer-encoding': 'chunked' }), false);
  assert.equal(hasFramingConflict({ 'content-length': '5' }), false);
  assert.equal(hasFramingConflict({}), false);
});

test('clientIpFromXff takes the second-to-last entry', () => {
  assert.equal(clientIpFromXff('1.2.3.4, 10.0.0.1'), '1.2.3.4');
  assert.equal(clientIpFromXff('1.2.3.4,10.0.0.1'), '1.2.3.4');
  assert.equal(clientIpFromXff('9.9.9.9, 1.2.3.4, 10.0.0.1'), '1.2.3.4');
  assert.equal(clientIpFromXff('10.0.0.1'), undefined);
  assert.equal(clientIpFromXff(''), undefined);
  assert.equal(clientIpFromXff(undefined), undefined);
});

test('normalizeRequestHeaders rewrites the fence headers and overwrites XFF', () => {
  const out = normalizeRequestHeaders(
    {
      host: 'dsh.example.com',
      origin: 'https://dsh.example.com',
      'sec-fetch-site': 'cross-site',
      'x-forwarded-for': '9.9.9.9, 10.0.0.1',
      'x-real-ip': '9.9.9.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'dsh.example.com',
      forwarded: 'for=9.9.9.9',
      accept: '*/*',
      'user-agent': 'probe',
    },
    { targetAuthority: '127.0.0.1:55570', clientIp: '9.9.9.9' },
  );
  assert.equal(out.host, '127.0.0.1:55570');
  assert.equal(out.origin, undefined);
  assert.equal(out['sec-fetch-site'], undefined);
  assert.equal(out['x-real-ip'], undefined);
  assert.equal(out['x-forwarded-proto'], undefined);
  assert.equal(out['x-forwarded-host'], undefined);
  assert.equal(out.forwarded, undefined);
  assert.equal(out['x-forwarded-for'], '9.9.9.9');
  assert.equal(out.accept, '*/*');
  assert.equal(out['user-agent'], 'probe');
});

test('normalizeRequestHeaders drops XFF when there is no client IP', () => {
  const out = normalizeRequestHeaders({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', accept: '*/*' }, { targetAuthority: '127.0.0.1:55570' });
  assert.equal(out['x-forwarded-for'], undefined);
  assert.equal(out.host, '127.0.0.1:55570');
});

test('rewriteResponseHeaders strips and harvests Set-Cookie (red line)', () => {
  const { headers, harvestedCookies } = rewriteResponseHeaders(
    {
      'set-cookie': 'dsh-auth-abc=SECRET; Path=/; HttpOnly',
      'set-cookie2': 'legacy=1; Path=/',
      'content-type': 'text/html',
      connection: 'keep-alive',
    },
    { publicBaseUrl: 'https://dsh.example.com' },
  );
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers['set-cookie2'], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['content-type'], 'text/html');
  assert.deepEqual(harvestedCookies, ['dsh-auth-abc=SECRET; Path=/; HttpOnly', 'legacy=1; Path=/']);
});

test('rewriteResponseHeaders harvests every value of an array-valued Set-Cookie', () => {
  const { headers, harvestedCookies } = rewriteResponseHeaders(
    { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
    { publicBaseUrl: 'https://dsh.example.com' },
  );
  assert.equal(headers['set-cookie'], undefined);
  assert.deepEqual(harvestedCookies, ['a=1; Path=/', 'b=2; Path=/']);
});

test('rewriteResponseHeaders rewrites Location to the public base URL', () => {
  const { headers } = rewriteResponseHeaders({ location: 'http://127.0.0.1:55570/a?b=1' }, { publicBaseUrl: 'https://dsh.example.com' });
  assert.equal(headers.location, 'https://dsh.example.com/a?b=1');
});

test('rewriteLocation handles absolute, root-relative and relative targets', () => {
  assert.equal(rewriteLocation('http://127.0.0.1:55570/x', 'https://dsh.example.com'), 'https://dsh.example.com/x');
  assert.equal(rewriteLocation('/x?q=1', 'https://dsh.example.com'), 'https://dsh.example.com/x?q=1');
  assert.equal(rewriteLocation('https://dsh.example.com/base/', 'https://dsh.example.com'), 'https://dsh.example.com/base/');
  assert.equal(rewriteLocation('http://127.0.0.1:55570/p#frag', 'https://dsh.example.com/'), 'https://dsh.example.com/p#frag');
});

test('parseRequestTarget turns absolute-form into path-form', () => {
  assert.equal(parseRequestTarget('http://dsh.example.com/x?q=1'), '/x?q=1');
  assert.equal(parseRequestTarget('/x?q=1'), '/x?q=1');
  assert.equal(parseRequestTarget('https://dsh.example.com'), '/');
});
