import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackAuthExempt } from '../src/config.ts';

test('direct loopback peer without X-Forwarded-For is auth-exempt', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAuthExempt(peer, undefined), true, peer);
  }
});

test('loopback peer with X-Forwarded-For is not auth-exempt', () => {
  assert.equal(isLoopbackAuthExempt('127.0.0.1', '100.64.0.2'), false);
  assert.equal(isLoopbackAuthExempt('127.0.0.1', ''), false, 'header presence is enough to guard');
});

test('non-loopback peer is not auth-exempt', () => {
  assert.equal(isLoopbackAuthExempt('100.64.0.2', undefined), false);
});
