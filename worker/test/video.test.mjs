import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { mintCookie } from '../src/index.js';

const TALK = 'feltham-sfi-2026-cognitive-representations';
const PAPER = 'feltham-seeing-structure-similarly';
const COOKIE_SECRET = 'cookie-secret-at-least-32-bytes-long!!';
const SIZE = 90116454;

/** Minimal R2 stub honouring the {range: Headers} contract. */
function bucket() {
  return {
    async get(key, opts) {
      if (key !== `${TALK}.mp4` && key !== `${PAPER}.pdf`) return null;
      const size = key.endsWith('.mp4') ? SIZE : 1000;
      let range;
      const h = opts?.range;
      const raw = h && typeof h.get === 'function' ? h.get('range') : null;
      if (raw) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
        if (m) {
          if (m[1] === '') range = { suffix: Number(m[2]) };
          else {
            const offset = Number(m[1]);
            const end = m[2] === '' ? size - 1 : Number(m[2]);
            range = { offset, length: end - offset + 1 };
          }
        }
      }
      return {
        body: new Uint8Array([0]),
        size,
        range,
        httpEtag: '"stub-etag"',
        writeHttpMetadata(headers) { headers.set('content-type', 'application/octet-stream'); },
      };
    },
  };
}

const env = {
  TURNSTILE_SITEKEY: '0xSITEKEY', TURNSTILE_SECRET: '0xSECRET', COOKIE_SECRET,
  PAPERS: bucket(),
};

const req = (path, headers = {}) =>
  worker.fetch(new Request(`https://h${path}`, { headers }), env);

async function authed(path, headers = {}) {
  const c = await mintCookie(COOKIE_SECRET);
  return req(path, { ...headers, cookie: `pp_pass=${c}` });
}

test('THE KEY TEST: /v/ without a cookie is 403, never video bytes', async () => {
  const res = await req(`/v/${TALK}`);
  assert.equal(res.status, 403, 'must be 403, not 302 — a <video> cannot follow a redirect');
  assert.equal(res.headers.get('content-range'), null);
});

test('/t/ without a cookie redirects to the gate', async () => {
  const res = await req(`/t/${TALK}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/p/${TALK}`);
});

test('/t/ with a cookie renders the player pointing at /v/', async () => {
  const res = await authed(`/t/${TALK}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`src="/v/${TALK}"`));
  assert.match(body, /Cognitive representations of social networks/);
  assert.match(body, /Santa Fe Institute/);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

test('a range request returns 206 with a correct Content-Range', async () => {
  const res = await authed(`/v/${TALK}`, { range: 'bytes=0-1023' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1023/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '1024');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
});

test('an open-ended range (what <video> actually sends first) works', async () => {
  const res = await authed(`/v/${TALK}`, { range: 'bytes=0-' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${SIZE - 1}/${SIZE}`);
});

test('a mid-file seek range works', async () => {
  const res = await authed(`/v/${TALK}`, { range: 'bytes=50000000-50001000' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 50000000-50001000/${SIZE}`);
});

test('a suffix range is normalised correctly', async () => {
  const res = await authed(`/v/${TALK}`, { range: 'bytes=-500' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '500');
});

test('no Range header yields 200 but still advertises range support', async () => {
  const res = await authed(`/v/${TALK}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), String(SIZE));
  assert.equal(res.headers.get('content-range'), null);
});

test('AI crawlers are refused on the video routes too', async () => {
  for (const ua of ['GPTBot/1.2', 'ClaudeBot/1.0', 'Bytespider']) {
    assert.equal((await req(`/v/${TALK}`, { 'user-agent': ua })).status, 403, ua);
    assert.equal((await req(`/t/${TALK}`, { 'user-agent': ua })).status, 403, ua);
  }
});

test('a talk is not downloadable through the paper route', async () => {
  assert.equal((await authed(`/f/${TALK}`)).status, 404);
});

test('a paper is not reachable through the talk or video routes', async () => {
  assert.equal((await authed(`/t/${PAPER}`)).status, 404);
  assert.equal((await authed(`/v/${PAPER}`)).status, 404);
});

test('unlock sends talks to /t/ and papers to /f/', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  try {
    for (const [slug, dest] of [[TALK, `/t/${TALK}`], [PAPER, `/f/${PAPER}`]]) {
      const body = new FormData();
      body.append('slug', slug);
      body.append('cf-turnstile-response', 'ok');
      const res = await worker.fetch(
        new Request('https://h/unlock', { method: 'POST', body }), env);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), dest, slug);
    }
  } finally { globalThis.fetch = real; }
});

test('the gate page still renders for a talk', async () => {
  const res = await req(`/p/${TALK}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Cognitive representations of social networks/);
});

test('gate copy fits the kind of item being gated', async () => {
  const talk = await req(`/p/${TALK}`).then((r) => r.text());
  assert.match(talk, /This recording is available to human viewers/);
  assert.match(talk, /<button type="submit">Watch recording<\/button>/);
  assert.doesNotMatch(talk, /Open PDF/);
  assert.doesNotMatch(talk, /working paper/);

  const paper = await req(`/p/${PAPER}`).then((r) => r.text());
  assert.match(paper, /This working paper is available to human readers/);
  assert.match(paper, /<button type="submit">Open PDF<\/button>/);
  assert.doesNotMatch(paper, /Watch recording/);
});
