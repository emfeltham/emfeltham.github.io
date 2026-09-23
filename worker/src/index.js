/**
 * Captcha-gated delivery of working-paper PDFs.
 *
 * The PDFs live in a private R2 bucket with no public URL. The only way out is
 * GET /f/<slug>, which requires a signed cookie that is issued solely by
 * POST /unlock after Cloudflare Turnstile validates a token server-side.
 *
 *   GET  /p/<slug>   gate page with the Turnstile widget
 *   POST /unlock     verify token -> set signed cookie -> 302 to /f/<slug>
 *   GET  /f/<slug>   validate cookie -> stream PDF from R2
 *   GET  /robots.txt Disallow: /
 */

const COOKIE_NAME = 'pp_pass';
export const COOKIE_TTL_SECONDS = 6 * 60 * 60; // outlives a full-length talk
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Slug -> item. Only slugs listed here are reachable, so an attacker cannot
 * enumerate arbitrary R2 keys. `kind` is 'paper' (served as a file at /f/) or
 * 'talk' (played at /t/, bytes streamed from /v/).
 */
const CATALOG = {
  'feltham-seeing-structure-similarly': {
    kind: 'paper',
    contentType: 'application/pdf',
    title: 'Seeing Structure Similarly',
    key: 'feltham-seeing-structure-similarly.pdf',
  },
  'feltham-signal-degradation-without-convergence': {
    kind: 'paper',
    contentType: 'application/pdf',
    title: 'Signal Degradation without Convergence: Scale Relevance and Partisan Boundary Investment',
    key: 'feltham-signal-degradation-without-convergence.pdf',
  },
  'feltham-fall-implicit-racial-bias': {
    kind: 'paper',
    contentType: 'application/pdf',
    title: 'The Decline in White Americans\u2019 Implicit Racial Bias Diverged in 2016 Along the Geography of Manufacturing Decline',
    key: 'feltham-fall-implicit-racial-bias.pdf',
  },
  'feltham-ppb-youdens-j': {
    kind: 'paper',
    contentType: 'application/pdf',
    title: 'The Yes Rate Revisited: PPB as a Distribution-Free Complement to Youden’s J',
    key: 'feltham-ppb-youdens-j.pdf',
  },
  'feltham-empirica-networks': {
    kind: 'paper',
    contentType: 'application/pdf',
    title: 'empirica-networks: online network experiments with Empirica',
    key: 'feltham-empirica-networks.pdf',
  },
  'feltham-sfi-2026-cognitive-representations': {
    kind: 'talk',
    contentType: 'video/mp4',
    title: 'Cognitive representations of social networks',
    venue: 'Santa Fe Institute Invited Seminar',
    date: 'April 16, 2026',
    key: 'feltham-sfi-2026-cognitive-representations.mp4',
  },
};

/** Known AI/LLM crawlers, rejected before spending a captcha verification. */
const AI_CRAWLERS =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|anthropic-ai|Claude-Web|CCBot|PerplexityBot|Bytespider|meta-externalagent|Amazonbot|Diffbot|omgili|Google-Extended|Applebot-Extended|Timpibot|ImagesiftBot|Webzio|DataForSeoBot/i;

const REQUIRED_CONFIG = ['TURNSTILE_SITEKEY', 'TURNSTILE_SECRET', 'COOKIE_SECRET'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const missing = REQUIRED_CONFIG.filter((k) => !env[k]);
    if (missing.length) {
      // Logged for `wrangler tail`; the response stays generic on purpose.
      console.error(`Worker misconfigured, missing: ${missing.join(', ')}`);
      return text('This service is temporarily unavailable.\n', 503);
    }

    if (AI_CRAWLERS.test(request.headers.get('user-agent') || '')) {
      return text('Not available to automated crawlers.\n', 403);
    }

    if (path === '/robots.txt') {
      return text('User-agent: *\nDisallow: /\n', 200);
    }

    if (request.method === 'POST' && path === '/unlock') {
      return handleUnlock(request, env);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const gate = path.match(/^\/p\/([a-z0-9-]+)\/?$/);
      if (gate) return handleGate(gate[1], env);

      const file = path.match(/^\/f\/([a-z0-9-]+)\/?$/);
      if (file) return handleFile(file[1], request, env);

      const talk = path.match(/^\/t\/([a-z0-9-]+)\/?$/);
      if (talk) return handleTalk(talk[1], request, env);

      const media = path.match(/^\/v\/([a-z0-9-]+)\/?$/);
      if (media) return handleMedia(media[1], request, env);
    }

    return text('Not found\n', 404);
  },
};

/* ---------------------------------------------------------------- handlers */

function handleGate(slug, env) {
  const paper = CATALOG[slug];
  if (!paper) return text('Not found\n', 404);
  return html(gatePage(slug, paper, env.TURNSTILE_SITEKEY));
}

async function handleUnlock(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return text('Bad request\n', 400);
  }

  const slug = String(form.get('slug') || '');
  const token = String(form.get('cf-turnstile-response') || '');
  const paper = CATALOG[slug];
  if (!paper) return text('Not found\n', 404);
  if (!token) return html(gatePage(slug, paper, env.TURNSTILE_SITEKEY, true), 400);

  // The security boundary: the widget alone proves nothing, this call does.
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);

  let ok = false;
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
    ok = res.ok && (await res.json()).success === true;
  } catch {
    ok = false;
  }
  if (!ok) return html(gatePage(slug, paper, env.TURNSTILE_SITEKEY, true), 403);

  const cookie = await mintCookie(env.COOKIE_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${paper.kind === 'talk' ? '/t' : '/f'}/${slug}`,
      'set-cookie': `${COOKIE_NAME}=${cookie}; Max-Age=${COOKIE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'private, no-store',
    },
  });
}

async function handleFile(slug, request, env) {
  const paper = CATALOG[slug];
  // Talks are streamed from /v/, never handed out whole here.
  if (!paper || paper.kind === 'talk') return text('Not found\n', 404);

  const cookie = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (!(await verifyCookie(cookie, env.COOKIE_SECRET))) {
    return new Response(null, {
      status: 302,
      headers: { location: `/p/${slug}`, 'cache-control': 'private, no-store' },
    });
  }

  const object = await env.PAPERS.get(paper.key);
  if (!object) return text('Not found\n', 404);

  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'content-type': paper.contentType,
      'content-disposition': `inline; filename="${paper.key}"`,
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, noarchive, noai, noimageai',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function handleTalk(slug, request, env) {
  const item = CATALOG[slug];
  if (!item || item.kind !== 'talk') return text('Not found\n', 404);

  const cookie = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (!(await verifyCookie(cookie, env.COOKIE_SECRET))) {
    return new Response(null, {
      status: 302,
      headers: { location: `/p/${slug}`, 'cache-control': 'private, no-store' },
    });
  }
  return html(playerPage(slug, item));
}

async function handleMedia(slug, request, env) {
  const item = CATALOG[slug];
  if (!item || item.kind !== 'talk') return text('Not found\n', 404);

  const cookie = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (!(await verifyCookie(cookie, env.COOKIE_SECRET))) {
    // 403 rather than a redirect: a <video> that follows a 302 to an HTML gate
    // page surfaces an opaque media error instead of failing cleanly.
    return text('Forbidden\n', 403);
  }

  const object = await env.PAPERS.get(item.key, { range: request.headers });
  if (!object) return text('Not found\n', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', item.contentType);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('x-robots-tag', 'noindex, noarchive, noai, noimageai');
  headers.set('referrer-policy', 'no-referrer');

  let status = 200;
  if (request.headers.has('range') && object.range) {
    // R2Range is {offset,length} or {suffix}; normalise both.
    const offset = object.range.offset ?? object.size - object.range.suffix;
    const length = object.range.length ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    status = 206;
  } else {
    headers.set('content-length', String(object.size));
  }

  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

/* ------------------------------------------------------------ signed cookie */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(message, secret) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintCookie(secret) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  return `${exp}.${await sign(String(exp), secret)}`;
}

export async function verifyCookie(value, secret) {
  if (!value || !secret) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  try {
    return timingSafeEqual(value.slice(dot + 1), await sign(exp, secret));
  } catch {
    return false; // fail closed: a crypto error must never open the gate
  }
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/* ---------------------------------------------------------------- responses */

const text = (body, status) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function playerPage(slug, item) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(item.title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #555; --bg: #fffff8; --rule: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --muted: #a0a0a0; --bg: #151515; --rule: #333; } }
  body { background: var(--bg); color: var(--fg); margin: 0;
         font-family: Palatino, "Palatino Linotype", Georgia, serif; line-height: 1.5; }
  main { max-width: 52rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { font-size: 1.35rem; font-weight: normal; font-style: italic; margin: 0 0 .4rem; }
  p.meta { color: var(--muted); font-size: .95rem; margin: 0 0 1.5rem; }
  video { width: 100%; max-width: 100%; height: auto; aspect-ratio: 16 / 9;
          background: #000; border: 1px solid var(--rule); border-radius: 2px; display: block; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
  p.note { color: var(--muted); font-size: .9rem; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(item.title)}</h1>
  <p class="meta">${escapeHtml(item.venue)} &middot; ${escapeHtml(item.date)}</p>
  <video controls preload="metadata" playsinline controlsList="nodownload"
         src="/v/${escapeHtml(slug)}"></video>
  <hr>
  <p class="note">Trouble playing this? Email
    <a href="mailto:eric.feltham@aya.yale.edu">eric.feltham@aya.yale.edu</a>.</p>
</main>
</body>
</html>`;
}

function gatePage(slug, item, sitekey, failed = false) {
  const isTalk = item.kind === 'talk';
  const noun = isTalk ? 'recording' : 'working paper';
  const audience = isTalk ? 'viewers' : 'readers';
  const action = isTalk ? 'Watch recording' : 'Open PDF';
  const title = item.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #555; --bg: #fffff8; --rule: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --muted: #a0a0a0; --bg: #151515; --rule: #333; } }
  body { background: var(--bg); color: var(--fg); margin: 0;
         font-family: Palatino, "Palatino Linotype", Georgia, serif; line-height: 1.5; }
  main { max-width: 34rem; margin: 0 auto; padding: 4rem 1.25rem; }
  h1 { font-size: 1.35rem; font-weight: normal; font-style: italic; margin: 0 0 1.5rem; }
  p { color: var(--muted); font-size: .95rem; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
  button { font: inherit; font-size: .95rem; padding: .45rem 1.1rem; margin-top: 1.25rem;
           background: none; color: var(--fg); border: 1px solid var(--fg); border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--fg); color: var(--bg); }
  .err { color: #b00020; }
  @media (prefers-color-scheme: dark) { .err { color: #ff8a80; } }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>This ${noun} is available to human ${audience}. Complete the check below, then press <strong>${escapeHtml(action)}</strong>.</p>
  ${failed ? '<p class="err">That verification did not go through. Please try again.</p>' : ''}
  <hr>
  <form method="POST" action="/unlock">
    <input type="hidden" name="slug" value="${escapeHtml(slug)}">
    <div class="cf-turnstile" data-sitekey="${escapeHtml(sitekey)}"></div>
    <button type="submit">${escapeHtml(action)}</button>
  </form>
  <hr>
  <p>Trouble? Email <a href="mailto:eric.feltham@aya.yale.edu" style="color:inherit">eric.feltham@aya.yale.edu</a> for a copy.</p>
</main>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body>
</html>`;
}
