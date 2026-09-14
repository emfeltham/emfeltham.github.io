import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { mintCookie } from '../src/index.js';

const SLUG = 'feltham-seeing-structure-similarly';
const COOKIE_SECRET = 'cookie-secret-at-least-32-bytes-long!!';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake');

const env = {
  TURNSTILE_SITEKEY: '0xSITEKEY',
  TURNSTILE_SECRET: '0xSECRET',
  COOKIE_SECRET,
  PAPERS: {
    async get(key) {
      return key === `${SLUG}.pdf` ? { body: PDF_BYTES } : null;
    },
  },
};

const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://papers.example.workers.dev${path}`, { headers }), env);

function stubSiteverify(success) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success }), { status: 200 });
  return () => { globalThis.fetch = real; };
}

async function unlock(token, slug = SLUG) {
  const body = new FormData();
  body.append('slug', slug);
  if (token !== null) body.append('cf-turnstile-response', token);
  return worker.fetch(
    new Request('https://papers.example.workers.dev/unlock', { method: 'POST', body }),
    env,
  );
}

test('gate page renders with the sitekey and leaks no PDF', async () => {
  const res = await get(`/p/${SLUG}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /0xSITEKEY/);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.doesNotMatch(body, /%PDF/);
});

test('unknown slug 404s rather than reaching R2', async () => {
  assert.equal((await get('/p/not-a-real-paper')).status, 404);
  assert.equal((await get('/f/not-a-real-paper')).status, 404);
});

test('THE KEY TEST: /f/ without a cookie redirects to the gate, never the PDF', async () => {
  const res = await get(`/f/${SLUG}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/p/${SLUG}`);
  assert.doesNotMatch(await res.text(), /%PDF/);
});

test('/f/ with a valid cookie serves the PDF', async () => {
  const cookie = await mintCookie(COOKIE_SECRET);
  const res = await get(`/f/${SLUG}`, { cookie: `pp_pass=${cookie}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(await res.text(), /%PDF/);
});

test('/f/ with a cookie signed by the wrong secret is turned away', async () => {
  const forged = await mintCookie('attacker-secret');
  const res = await get(`/f/${SLUG}`, { cookie: `pp_pass=${forged}` });
  assert.equal(res.status, 302);
});

test('known AI crawlers are rejected on every route', async () => {
  for (const ua of ['GPTBot/1.2', 'ClaudeBot/1.0', 'CCBot/2.0', 'PerplexityBot', 'Bytespider']) {
    assert.equal((await get(`/f/${SLUG}`, { 'user-agent': ua })).status, 403, ua);
    assert.equal((await get(`/p/${SLUG}`, { 'user-agent': ua })).status, 403, ua);
  }
});

test('an ordinary browser UA is not blocked', async () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141 Safari/537.36';
  assert.equal((await get(`/p/${SLUG}`, { 'user-agent': ua })).status, 200);
});

test('unlock without a token re-renders the gate, does not issue a cookie', async () => {
  const res = await unlock(null);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('unlock with a token that fails siteverify issues no cookie', async () => {
  const restore = stubSiteverify(false);
  try {
    const res = await unlock('bad-token');
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally { restore(); }
});

test('full flow: passing siteverify yields a cookie that opens the PDF', async () => {
  const restore = stubSiteverify(true);
  let setCookie;
  try {
    const res = await unlock('good-token');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/f/${SLUG}`);
    setCookie = res.headers.get('set-cookie');
  } finally { restore(); }

  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);

  const value = setCookie.split(';')[0].split('=')[1];
  const pdf = await get(`/f/${SLUG}`, { cookie: `pp_pass=${value}` });
  assert.equal(pdf.status, 200);
  assert.match(await pdf.text(), /%PDF/);
});

test('robots.txt disallows everything', async () => {
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \/$/m);
});

test('unrouted paths 404', async () => {
  for (const p of ['/', '/f/', '/p/', '/../etc/passwd', '/unlock', `/f/${SLUG}/extra`]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

/* Regression tests for the live 500 (Cloudflare error 1101): a cookie with a
   valid future expiry reached the HMAC call with no COOKIE_SECRET set, and the
   Workers runtime rejects a zero-length HMAC key where Node tolerates it. */

test('missing secrets yield a clean 503, never a runtime crash', async () => {
  for (const drop of ['TURNSTILE_SITEKEY', 'TURNSTILE_SECRET', 'COOKIE_SECRET']) {
    const broken = { ...env, [drop]: undefined };
    const res = await worker.fetch(
      new Request(`https://h/f/${SLUG}`, { headers: { cookie: 'pp_pass=9999999999.deadbeef' } }),
      broken,
    );
    assert.equal(res.status, 503, `missing ${drop}`);
    assert.doesNotMatch(await res.text(), /TURNSTILE|COOKIE|secret/i, 'must not name the missing key');
  }
});

test('a forged cookie with a far-future expiry is denied, not crashed on', async () => {
  for (const c of ['9999999999.deadbeef', '9999999999.', '9999999999.' + 'a'.repeat(64), '1.a', 'x.y', 'garbage']) {
    const res = await worker.fetch(
      new Request(`https://h/f/${SLUG}`, { headers: { cookie: `pp_pass=${c}` } }), env);
    assert.equal(res.status, 302, `cookie ${JSON.stringify(c)}`);
  }
});

test('verifyCookie fails closed when the secret is absent', async () => {
  const { mintCookie, verifyCookie } = await import('../src/index.js');
  const real = await mintCookie('a-real-secret');
  assert.equal(await verifyCookie(real, undefined), false);
  assert.equal(await verifyCookie(real, ''), false);
});
