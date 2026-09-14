import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintCookie, verifyCookie, timingSafeEqual, readCookie, COOKIE_TTL_SECONDS } from '../src/index.js';

const SECRET = 'test-secret-value-at-least-32-bytes-long';

test('a freshly minted cookie verifies', async () => {
  assert.equal(await verifyCookie(await mintCookie(SECRET), SECRET), true);
});

test('a cookie minted with a different secret is rejected', async () => {
  assert.equal(await verifyCookie(await mintCookie('other-secret'), SECRET), false);
});

test('a tampered signature is rejected', async () => {
  const c = await mintCookie(SECRET);
  const [exp, sig] = c.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
  assert.equal(await verifyCookie(`${exp}.${flipped}`, SECRET), false);
});

test('extending the expiry invalidates the signature', async () => {
  const [exp, sig] = (await mintCookie(SECRET)).split('.');
  assert.equal(await verifyCookie(`${Number(exp) + 99999}.${sig}`, SECRET), false);
});

test('an expired cookie is rejected even though it is correctly signed', async () => {
  // Sign a timestamp already in the past, using the real signing path.
  const past = Math.floor(Date.now() / 1000) - 10;
  const fresh = await mintCookie(SECRET);
  const good = await verifyCookie(fresh, SECRET);
  assert.equal(good, true, 'sanity');
  // Reconstruct a valid signature over an expired timestamp by re-minting
  // with a patched clock.
  const realNow = Date.now;
  // Wind back further than the TTL, whatever it currently is.
  Date.now = () => (past - COOKIE_TTL_SECONDS) * 1000;
  const stale = await mintCookie(SECRET);
  Date.now = realNow;
  assert.equal(await verifyCookie(stale, SECRET), false);
});

test('malformed cookies are rejected, not crashed on', async () => {
  for (const bad of [null, '', '.', 'nodot', 'abc.def', '.deadbeef', '123', '-1.aa', '1e9.aa']) {
    assert.equal(await verifyCookie(bad, SECRET), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('timingSafeEqual behaves like equality', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('readCookie picks the right cookie out of a header', () => {
  assert.equal(readCookie('a=1; pp_pass=xyz; b=2', 'pp_pass'), 'xyz');
  assert.equal(readCookie('pp_pass=xyz', 'pp_pass'), 'xyz');
  assert.equal(readCookie('a=1; b=2', 'pp_pass'), null);
  assert.equal(readCookie(null, 'pp_pass'), null);
  assert.equal(readCookie('pp_pass=a=b', 'pp_pass'), 'a=b', 'value containing = survives');
});
