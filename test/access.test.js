import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess } from '../server/access.js';

const LOCAL = { lanEnabled: false, hostnames: new Set(['localhost', '127.0.0.1', '[::1]']) };
const LAN = { lanEnabled: true, hostnames: new Set(['localhost', '127.0.0.1', '[::1]', '192.168.1.10', 'server-it']) };

const req = (o) => ({ method: 'GET', path: '/api/status', host: 'localhost:3000', origin: undefined, remoteAddress: '127.0.0.1', isJson: false, ...o });

test('mode lokal: localhost boleh, PC lain ditolak', () => {
  assert.equal(checkAccess(req(), LOCAL), null);
  assert.equal(checkAccess(req({ remoteAddress: '::ffff:127.0.0.1' }), LOCAL), null);
  assert.equal(checkAccess(req({ host: '192.168.1.10:3000', remoteAddress: '192.168.1.20' }), LOCAL).status, 403);
});

test('mode LAN: PC lain boleh melihat lewat IP atau nama komputer server', () => {
  assert.equal(checkAccess(req({ host: '192.168.1.10:3000', remoteAddress: '192.168.1.20' }), LAN), null);
  assert.equal(checkAccess(req({ host: 'SERVER-IT:3000', remoteAddress: '192.168.1.20' }), LAN), null);
  assert.equal(checkAccess(req({ path: '/api/rejections/export', host: '192.168.1.10:3000', remoteAddress: '::ffff:192.168.1.20' }), LAN), null);
});

test('mode LAN: PC lain tidak boleh mengubah pengaturan/aturan, tetapi boleh "Ambil email sekarang"', () => {
  const remote = { host: '192.168.1.10:3000', remoteAddress: '192.168.1.20', isJson: true };
  for (const [method, path] of [
    ['PUT', '/api/settings'],
    ['POST', '/api/settings/test-connection'],
    ['POST', '/api/rules'],
    ['DELETE', '/api/rules/1'],
    ['POST', '/api/mailbox/rescan-ignored'],
  ]) {
    const res = checkAccess(req({ ...remote, method, path }), LAN);
    assert.equal(res?.status, 403, `${method} ${path}`);
    assert.match(res.error, /komputer server/);
  }
  assert.equal(checkAccess(req({ ...remote, method: 'POST', path: '/api/sync' }), LAN), null);
  // Dari komputer server sendiri tetap boleh.
  assert.equal(checkAccess(req({ method: 'PUT', path: '/api/settings', isJson: true }), LAN), null);
});

test('DNS rebinding, situs lain, dan form non-JSON tetap ditolak di mode LAN', () => {
  assert.equal(checkAccess(req({ host: 'evil.example', remoteAddress: '192.168.1.20' }), LAN).status, 403);
  assert.equal(checkAccess(req({ origin: 'https://evil.example', method: 'POST', path: '/api/sync', isJson: true }), LAN).status, 403);
  assert.equal(checkAccess(req({ origin: 'http://192.168.1.10:3000', method: 'POST', path: '/api/sync', isJson: true, remoteAddress: '192.168.1.20', host: '192.168.1.10:3000' }), LAN), null);
  assert.equal(checkAccess(req({ method: 'POST', path: '/api/sync', isJson: false }), LAN).status, 415);
});
