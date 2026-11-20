// HTTP API shared by the Node LAN server and the Cloudflare Durable Object.
// `store` is a small async key-value interface: get(key), put(key, value), list(prefix).
// `wordsText` is public/words.txt; the server checks every submitted word against it.

import { ROUNDS, ROUND_MS, GRACE_MS, SIZE, ADJ, roundDone, pathWord, pathPoints, summarize } from '../public/game.js';

const NAME = /^[a-z][a-z0-9_]{1,15}$/;
const TILE = /^(qu|[a-z])$/;
const MAX_BODY = 64 * 1024;
const MAX_WORDS = 400;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (data, status = 200) => new Response(JSON.stringify({ ...data, now: Date.now() }), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// Mutations must be same-origin JSON, so another site cannot post on a player's behalf.
function checkOrigin(request, url) {
  if (request.method !== 'POST') return;
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') fail(415, 'Send JSON');
  const origin = request.headers.get('origin');
  if (origin === null) return;
  let host = null;
  try { host = new URL(origin).host; } catch {}
  if (host !== url.host) fail(403, 'Cross-site request');
}

async function readBody(request) {
  if (request.method !== 'POST') return {};
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'Too large');
  try {
    const body = JSON.parse(text || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : fail(400, 'Bad request');
  } catch {
    fail(400, 'Bad request');
  }
}

const cleanName = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function validBoards(boards) {
  return Array.isArray(boards) && boards.length === ROUNDS && boards.every((b) =>
    b && Array.isArray(b.tiles) && Array.isArray(b.mult) &&
    b.tiles.length === SIZE * SIZE && b.mult.length === SIZE * SIZE &&
    b.tiles.every((t) => typeof t === 'string' && TILE.test(t)) &&
    b.mult.every((m) => m === 1 || m === 2 || m === 3) &&
    b.mult.filter((m) => m === 2).length === 1 && b.mult.filter((m) => m === 3).length === 1 &&
    b.mult.every((m, i) => m === 1 || b.tiles[i] !== 'qu'));
}

// A swipe is a list of distinct, touching tile indexes. Returns the word it spells.
function pathWordChecked(board, path) {
  const ok = Array.isArray(path) && path.length >= 2 && path.length <= SIZE * SIZE &&
    path.every((i, k) => Number.isInteger(i) && i >= 0 && i < SIZE * SIZE &&
      path.indexOf(i) === k && (k === 0 || ADJ[path[k - 1]].includes(i)));
  return ok ? pathWord(board, path) : fail(400, 'Bad swipe');
}

export function createApi(store, wordsText) {
  let dict = null;
  const isWord = (w) => w.length >= 3 && (dict ??= new Set(wordsText.split('\n'))).has(w);

  async function me(name) {
    const n = cleanName(name);
    if (!NAME.test(n) || !(await store.get(`u:${n}`))) fail(401, 'Sign in again');
    return n;
  }

  async function loadMatch(id, who) {
    const match = typeof id === 'string' && id.length <= 40 ? await store.get(`m:${id}`) : null;
    if (!match || !match.players.includes(who)) fail(404, 'No such match');
    return match;
  }

  async function save(match) {
    match.updatedAt = Date.now();
    await store.put(`m:${match.id}`, match);
    return match;
  }

  function newMatch(from, to, boards, rematchOf) {
    if (!validBoards(boards)) fail(400, 'Bad boards');
    return {
      id: crypto.randomUUID().slice(0, 13),
      players: [from, to],
      status: 'invited',
      boards: boards.map((b) => ({ tiles: b.tiles, mult: b.mult })),
      plays: [[null, null, null], [null, null, null]],
      createdAt: Date.now(),
      ...(rematchOf ? { rematchOf } : {}),
    };
  }

  const routes = {
    'POST login': async (_, body) => {
      const name = cleanName(body.name);
      if (!NAME.test(name)) fail(400, '2–16 letters, numbers or _');
      if (!(await store.get(`u:${name}`))) await store.put(`u:${name}`, { name, createdAt: Date.now() });
      return { name };
    },

    'GET home': async (url) => {
      const who = await me(url.searchParams.get('me'));
      const matches = (await store.list('m:'))
        .filter((m) => m.players.includes(who) && m.status !== 'declined')
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return { matches };
    },

    'POST invite': async (_, body) => {
      const who = await me(body.me);
      const to = cleanName(body.to);
      if (to === who) fail(400, "That's you");
      if (!NAME.test(to) || !(await store.get(`u:${to}`))) fail(404, `No player named ${to || '…'}`);
      return { match: await save(newMatch(who, to, body.boards)) };
    },

    // One rematch per finished match, linked from it. The first press creates it as an invite;
    // a repeat press returns it, and the opponent's press accepts it. A declined rematch can be replaced.
    // Each request runs without interleaving (Node queue, Durable Object input gates), so presses never race.
    'POST match/rematch': async (_, body, id) => {
      const who = await me(body.me);
      const match = await loadMatch(id, who);
      if (!summarize(match, who, Date.now()).done) fail(409, 'Finish the match first');
      let next = match.rematch ? await store.get(`m:${match.rematch}`) : null;
      if (next && next.status !== 'declined') {
        if (next.status === 'invited' && next.players[1] === who) {
          next.status = 'active';
          await save(next);
        }
        return { match: next };
      }
      next = await save(newMatch(who, match.players.find((p) => p !== who), body.boards, match.id));
      match.rematch = next.id;
      await store.put(`m:${match.id}`, match); // keeps updatedAt, the finish time history shows
      return { match: next };
    },

    'GET match/': async (url, _, id) => {
      const match = await loadMatch(id, await me(url.searchParams.get('me')));
      return { match, rematch: match.rematch ? await store.get(`m:${match.rematch}`) : null };
    },

    'POST match/respond': async (_, body, id) => {
      const who = await me(body.me);
      const match = await loadMatch(id, who);
      if (match.status !== 'invited' || match.players[1] !== who) fail(409, 'Already answered');
      match.status = body.accept ? 'active' : 'declined';
      return { match: await save(match) };
    },

    // Starts a round on first call, then merges in found words. Each call sends every swipe path
    // the player has found; the server derives words and points itself and never removes a word,
    // so stale or reordered saves and a second tab can only add progress.
    'POST match/play': async (_, body, id) => {
      const who = await me(body.me);
      const match = await loadMatch(id, who);
      const pi = match.players.indexOf(who);
      const r = body.round;
      if (!Number.isInteger(r) || r < 0 || r >= ROUNDS) fail(400, 'Bad round');
      if (match.status === 'declined' || (match.status === 'invited' && pi === 1)) fail(409, 'Accept the invite first');
      const now = Date.now();
      const plays = match.plays[pi];
      if (r > 0 && !roundDone(plays[r - 1], now)) fail(409, 'Finish the earlier round first');
      let play = plays[r];
      if (!play) {
        play = plays[r] = { startedAt: now, endedAt: null, words: [], attempts: 0 };
      } else if (!play.endedAt && now <= play.startedAt + ROUND_MS + GRACE_MS) {
        const board = match.boards[r];
        if (body.found !== undefined) {
          if (!Array.isArray(body.found) || body.found.length > MAX_WORDS) fail(400, 'Bad words');
          const have = new Set(play.words.map((w) => w.w));
          const add = body.found.map((path) => {
            const w = pathWordChecked(board, path);
            if (!isWord(w)) fail(400, `${w} is not a word`);
            return { w, p: pathPoints(board, path), path };
          });
          for (const x of add) if (!have.has(x.w) && play.words.length < MAX_WORDS) { have.add(x.w); play.words.push(x); }
        }
        if (Number.isInteger(body.attempts) && body.attempts < 10_000) play.attempts = Math.max(play.attempts, body.attempts);
      }
      play.attempts = Math.max(play.attempts, play.words.length);
      if (!play.endedAt && (body.done || now > play.startedAt + ROUND_MS + GRACE_MS)) play.endedAt = Math.min(now, play.startedAt + ROUND_MS);
      return { match: await save(match) };
    },
  };

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      checkOrigin(request, url);
      const [api, a, id, b] = url.pathname.split('/').filter(Boolean);
      if (api !== 'api') fail(404, 'Not found');
      const name = a === 'match' ? (id ? `match/${b ?? ''}` : '') : (id ? '' : a);
      const route = routes[`${request.method} ${name}`];
      if (!route) fail(404, 'Not found');
      return json(await route(url, await readBody(request), id));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
  };
}
