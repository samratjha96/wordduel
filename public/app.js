import * as G from './game.js';
import { unlock, sfx, isMuted, setMuted } from './sound.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = localStorage.getItem('wd:me');
let clockOffset = 0;
let teardown = [];

document.addEventListener('pointerdown', unlock, { capture: true });

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const now = () => Date.now() + clockOffset;
const $ = (sel, root = app) => root.querySelector(sel);
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const buzz = (ms) => navigator.vibrate?.(ms);

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// Polls only while the page is visible, and once more on return, so idle phones cost no requests.
function every(ms, fn) {
  const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
  const onShow = () => { if (!document.hidden) fn(); };
  document.addEventListener('visibilitychange', onShow);
  teardown.push(() => document.removeEventListener('visibilitychange', onShow));
  teardown.push(() => clearInterval(id));
}

async function api(path, body) {
  const sent = Date.now();
  const res = await fetch(`/api/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (data.now) clockOffset = data.now - (sent + Date.now()) / 2;
  if (res.status === 401) { signOut(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Connection problem');
  return data;
}

let dictPromise = null;
const dict = () => (dictPromise ??= fetch('/words.txt?v=2')
  .then((r) => { if (!r.ok) throw new Error('Word list missing'); return r.text(); })
  .then(G.parseDict)
  .catch((e) => { dictPromise = null; throw e; }));

const solved = new Map();
async function solutions(board) {
  const key = board.tiles.join('') + board.mult.join('');
  if (!solved.has(key)) solved.set(key, G.solve(board, (await dict()).words));
  return solved.get(key);
}

function signOut() {
  me = null;
  localStorage.removeItem('wd:me');
  go('#/');
}

// ---------- routing ----------

function route() {
  teardown.forEach((f) => f());
  teardown = [];
  window.scrollTo(0, 0);
  const h = location.hash.slice(1) || '/';
  if (!me) return renderLogin();
  dict().catch(() => {});
  if (h === '/solo') return renderSolo();
  const m = h.match(/^\/m\/([\w-]+)(?:\/r\/([0-2]))?$/);
  if (m && m[2] != null) return openRound(m[1], Number(m[2]));
  if (m) return renderMatch(m[1]);
  return renderHome();
}
window.addEventListener('hashchange', route);

function screen(cls, html) {
  app.innerHTML = `<section class="screen ${cls}">${html}</section>`;
  return app.firstElementChild;
}

// ---------- login ----------

function renderLogin() {
  dict().catch(() => {});
  const mark = 'WORDDUEL'.split('').map((c, i) => `<span class="mtile" style="--i:${i}">${c}</span>`).join('');
  const el = screen('login', `
    <div class="mark" aria-label="Wordduel">${mark}</div>
    <form class="entry">
      <input name="name" placeholder="Your name" autocomplete="username" autocapitalize="none"
        autocorrect="off" spellcheck="false" maxlength="16" required>
      <button class="btn primary">Play</button>
    </form>`);
  const form = $('form', el);
  form.name.value = localStorage.getItem('wd:last') || '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { name } = await api('login', { name: form.name.value });
      me = name;
      localStorage.setItem('wd:me', name);
      localStorage.setItem('wd:last', name);
      go('#/');
    } catch (err) { toast(err.message); }
  });
}

// ---------- home ----------

function dots(sum) {
  return `<span class="dots">${sum.rounds.map((x) =>
    `<i class="${x.myDone ? 'done' : ''} ${x.winner ? `w-${x.winner}` : ''}"></i>`).join('')}</span>`;
}

function homeRow(match, t) {
  const s = G.summarize(match, me, t);
  const href = `#/m/${match.id}`;
  const name = `<span class="who">${esc(s.opp)}</span>`;
  if (s.invitedMe) {
    return { group: 0, html: `<div class="row invite">${name}
      <span class="act"><button class="btn ghost sm" data-respond="${match.id}" data-accept="0">Decline</button>
      <button class="btn primary sm" data-respond="${match.id}" data-accept="1">Accept</button></span></div>` };
  }
  if (s.done) {
    const label = { win: 'Won', loss: 'Lost', tie: 'Tie' }[s.result];
    return { group: 3, html: `<a class="row" href="${href}">${name}
      <span class="res ${s.result}">${label}</span>
      <span class="meta">${fmt(s.totals[0])}–${fmt(s.totals[1])} · ${day(match.updatedAt)}</span></a>` };
  }
  if (s.next >= 0) {
    const live = s.rounds[s.next].live;
    return { group: 1, html: `<a class="row turn" href="${href}">${name}${dots(s)}
      <span class="go">${live ? 'Resume' : `Round ${s.next + 1}`}</span></a>` };
  }
  return { group: 2, html: `<a class="row" href="${href}">${name}${dots(s)}
    <span class="meta">${s.pendingThem ? 'Invite sent' : 'Their turn'}</span></a>` };
}

function renderHome() {
  const el = screen('home', `
    <header class="bar">
      <span class="logo">Wordduel</span>
      <span class="tools">
        <button class="icon" data-mute aria-label="Sound"></button>
        <button class="me" data-me>${esc(me)}</button>
      </span>
    </header>
    <div class="hero">
      <button class="btn primary big" data-vs>Play against someone</button>
      <form class="invite" hidden>
        <input name="to" placeholder="Opponent's username" aria-label="Opponent's username" autocapitalize="none" autocorrect="off"
          spellcheck="false" maxlength="16" required>
        <button class="btn primary big">Start game</button>
      </form>
      <a class="btn quiet wide" href="#/solo">Play solo</a>
    </div>
    <div class="lists"></div>`);

  const muteBtn = $('[data-mute]', el);
  const paintMute = () => { muteBtn.innerHTML = speaker(!isMuted()); };
  paintMute();
  muteBtn.onclick = () => { setMuted(!isMuted()); paintMute(); if (!isMuted()) sfx.word(); };

  const meBtn = $('[data-me]', el);
  meBtn.onclick = () => {
    if (meBtn.dataset.armed) return signOut();
    meBtn.dataset.armed = '1';
    meBtn.textContent = 'Sign out';
    setTimeout(() => { delete meBtn.dataset.armed; meBtn.textContent = me; }, 2500);
  };

  const form = $('.invite', el);
  const vs = $('[data-vs]', el);
  vs.onclick = () => { vs.hidden = true; form.hidden = false; form.to.focus(); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const d = await dict();
      const boards = [0, 1, 2].map(() => G.makeBoard(d));
      const { match } = await api('invite', { me, to: form.to.value, boards });
      go(`#/m/${match.id}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Start game';
    }
  });

  const lists = $('.lists', el);
  lists.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-respond]');
    if (!b) return;
    b.disabled = true;
    try {
      const accept = b.dataset.accept === '1';
      const { match } = await api(`match/${b.dataset.respond}/respond`, { me, accept });
      if (accept) go(`#/m/${match.id}`); else load();
    } catch (err) { toast(err.message); b.disabled = false; }
  });

  const titles = ['Invites', 'Your turn', 'Waiting', 'History'];
  let last = '';
  async function load() {
    try {
      const { matches } = await api(`home?me=${encodeURIComponent(me)}`);
      const t = now();
      const groups = [[], [], [], []];
      for (const m of matches) { const r = homeRow(m, t); groups[r.group].push(r.html); }
      const html = groups.some((g) => g.length)
        ? groups.map((g, i) => (g.length ? `<section class="group"><h2>${titles[i]}</h2>${g.join('')}</section>` : '')).join('')
        : '<p class="empty">No games yet</p>';
      if (html !== last) { lists.innerHTML = html; last = html; }
    } catch (err) { if (me) toast(err.message); }
  }
  load();
  every(3000, load);
}

function speaker(on) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${on
    ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    : '<path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'}</svg>`;
}

// ---------- match ----------

function renderMatch(id) {
  const el = screen('match', `
    <header class="bar"><a class="back" href="#/" aria-label="Home">‹</a><span class="vs"></span><span></span></header>
    <div class="body"><p class="empty">…</p></div>`);
  const body = $('.body', el);
  let last = '';
  let wasPending = false;
  let reveal = false;
  let boards = null;
  let rematching = false;

  // The board set for a rematch is rolled ahead of time so the tap feels instant.
  const rematchBoards = () => (boards ??= dict().then((d) => [0, 1, 2].map(() => G.makeBoard(d))));

  function roundTable(s) {
    const rows = s.rounds.map((x) => {
      const mine = x.me ? fmt(x.me.points) : x.myDone ? fmt(x.raw) : x.live ? 'live' : '';
      const theirs = x.them ? fmt(x.them.points) : x.theirDone ? (x.myDone ? '' : '✓') : '';
      const tag = x.winner === 'me' ? 'won' : x.winner === 'them' ? 'lost' : '';
      const inner = `<span class="rn">${x.r + 1}</span><span class="pm">${mine}</span><span class="pt">${theirs}</span>`;
      return x.myDone
        ? `<a class="round ${tag}" href="#/m/${id}/r/${x.r}">${inner}</a>`
        : `<div class="round ${tag}">${inner}</div>`;
    }).join('');
    return `<div class="table"><div class="round th"><span class="rn"></span><span class="pm">${esc(me)}</span><span class="pt">${esc(s.opp)}</span></div>${rows}</div>`;
  }

  // Shown once every one of my rounds is over: pending until the opponent finishes, then the verdict.
  function finalHtml(s, match, rematch) {
    const myTotal = s.rounds.reduce((sum, x) => sum + x.raw, 0);
    const side = (name, points, tag) => `<div class="side ${tag}">
      <span class="nm">${esc(name)}</span>${tag === 'won' ? '<em>Winner</em>' : ''}
      <span class="pts">${points}</span></div>`;
    if (!s.done) {
      const live = s.rounds.find((x) => x.theirs && !x.theirDone);
      const played = s.rounds.filter((x) => x.theirDone).length;
      const status = s.pendingThem ? `${esc(s.opp)} hasn't accepted yet`
        : live ? `${esc(s.opp)} is playing round ${live.r + 1}`
        : played ? `${esc(s.opp)} has played ${played} of ${G.ROUNDS}` : `${esc(s.opp)} hasn't started`;
      return `<div class="final pending">
          <h1>Waiting for ${esc(s.opp)}</h1>
          <p class="sub"><i class="live-dot"></i>${status}</p>
        </div>
        <div class="board-score">${side(me, fmt(myTotal), 'mine')}${side(s.opp, '<span class="pend">···</span>', 'theirs')}</div>
        ${roundTable(s)}
        <div class="cta"><a class="btn quiet big" href="#/">Home</a></div>`;
    }
    const title = { win: 'You win', loss: `${esc(s.opp)} wins`, tie: 'Draw' }[s.result];
    const tags = { win: ['won', 'lost'], loss: ['lost', 'won'], tie: ['tie', 'tie'] }[s.result];
    const sides = [side(me, fmt(s.totals[0]), tags[0]), side(s.opp, fmt(s.totals[1]), tags[1])];
    if (s.result === 'loss') sides.reverse();

    let note = '';
    let label = 'Rematch';
    if (rematch && rematch.status !== 'declined') {
      const theyAsked = rematch.status === 'invited' && rematch.players[1] === me;
      if (theyAsked) note = `<p class="ask">${esc(s.opp)} wants a rematch</p>`;
      else label = 'Go to rematch';
    }
    return `<div class="final ${s.result}${reveal ? ' reveal' : ''}">
        <h1>${title}</h1>
        <p class="sub">${Math.max(...s.won)}–${Math.min(...s.won)} in rounds</p>
      </div>
      <div class="board-score">${sides.join('')}</div>
      ${roundTable(s)}
      <div class="cta">${note}<button class="btn primary big" data-rematch>${label}</button>
        <a class="btn text" href="#/">Home</a></div>`;
  }

  async function load() {
    let match, rematch;
    try { ({ match, rematch } = await api(`match/${id}?me=${encodeURIComponent(me)}`)); } catch (err) { toast(err.message); return; }
    const s = G.summarize(match, me, now());
    $('.vs', el).innerHTML = `${esc(me)} <i>vs</i> ${esc(s.opp)}`;

    let html;
    if (s.next < 0 && !s.invitedMe) {
      const revealNow = s.done && wasPending;
      if (revealNow) reveal = true;
      html = finalHtml(s, match, rematch);
      if (s.done) {
        if (revealNow) { if (s.result === 'win') sfx.long(); else sfx.word(); }
        if (!rematch || rematch.status === 'declined') rematchBoards().catch(() => {});
      }
      wasPending = !s.done;
    } else {
      const action = s.invitedMe
        ? `<div class="pair"><button class="btn ghost" data-accept="0">Decline</button><button class="btn primary" data-accept="1">Accept</button></div>`
        : `<a class="btn primary big" href="#/m/${id}/r/${s.next}">${s.rounds[s.next].live ? 'Resume' : 'Play'} round ${s.next + 1}</a>`;
      html = `<div class="verdict"><b>${s.won[0]}–${s.won[1]}</b></div>${roundTable(s)}<div class="cta">${action}</div>`;
    }
    if (html !== last) { body.innerHTML = html; last = html; }
  }

  body.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rematch]');
    if (rm) {
      if (rematching) return;
      rematching = true;
      rm.disabled = true;
      try {
        const { match } = await api(`match/${id}/rematch`, { me, boards: await rematchBoards() });
        go(`#/m/${match.id}`);
      } catch (err) { toast(err.message); rm.disabled = false; }
      rematching = false;
      return;
    }
    const b = e.target.closest('[data-accept]');
    if (!b) return;
    b.disabled = true;
    try {
      const accept = b.dataset.accept === '1';
      await api(`match/${id}/respond`, { me, accept });
      if (accept) load(); else go('#/');
    } catch (err) { toast(err.message); b.disabled = false; }
  });

  load();
  every(3000, load);
}

// ---------- rounds ----------

async function openRound(id, r) {
  screen('play loading', '');
  let match;
  try { ({ match } = await api(`match/${id}?me=${encodeURIComponent(me)}`)); } catch (err) { toast(err.message); return go('#/'); }
  const s = G.summarize(match, me, now());
  const x = s.rounds[r];
  if (x.myDone) return renderResult({ match, r });
  if (s.next !== r || s.invitedMe) return go(`#/m/${id}`);

  const board = match.boards[r];
  let saved = Promise.resolve();
  // Sends every found swipe path; the server merges them and returns its copy of the round.
  const save = (words, attempts, done = false) => {
    const found = words.filter((w) => w.path).map((w) => w.path);
    saved = saved.then(() => api(`match/${id}/play`, { me, round: r, found, attempts, done }))
      .then((d) => d.match.plays[s.mi][r], () => null);
    return saved;
  };
  play({
    board,
    resume: x.mine,
    start: async () => (await api(`match/${id}/play`, { me, round: r })).match.plays[s.mi][r].startedAt,
    save,
    leave: `#/m/${id}`,
    end: async (words, attempts) => {
      await save(words, attempts, true);
      go(r === G.ROUNDS - 1 ? `#/m/${id}` : `#/m/${id}/r/${r}`);
    },
  });
}

async function renderSolo() {
  screen('play loading', '');
  let d;
  try { d = await dict(); } catch (err) { toast(err.message); return go('#/'); }
  const board = G.makeBoard(d);
  play({
    board,
    resume: null,
    start: async () => now(),
    save: () => {},
    leave: '#/',
    end: (found, attempts) => renderResult({
      solo: { board, play: { startedAt: 0, endedAt: 1, words: found, attempts } },
    }),
  });
}

function boardHtml(board) {
  return board.tiles.map((t, i) => {
    const m = board.mult[i];
    return `<div class="tile${m > 1 ? ` x${m}` : ''}" data-i="${i}"><span>${t === 'qu' ? 'Qu' : t.toUpperCase()}</span>${m > 1 ? `<b>${m}×</b>` : ''}</div>`;
  }).join('');
}

// The timed swipe round. Shared by match rounds and solo play.
async function play({ board, resume, start, save, leave, end }) {
  const el = screen('play', `
    <div class="timer"><i></i></div>
    <header class="bar playbar">
      <a class="back" href="${leave}" aria-label="Leave">‹</a>
      <span class="clock">1:30</span>
      <span class="score">0</span>
    </header>
    <div class="word"><span class="letters"></span><span class="hint"></span></div>
    <div class="board-wrap">
      <div class="board">
        <svg class="trail" aria-hidden="true"><polyline/></svg>
        ${boardHtml(board)}
      </div>
    </div>
    <footer class="found"><span class="count">0 words</span><span class="last"></span></footer>
    <div class="countdown"></div>`);

  const boardEl = $('.board', el);
  const tiles = [...el.querySelectorAll('.tile')];
  const line = $('polyline', el);
  const lettersEl = $('.letters', el);
  const hintEl = $('.hint', el);
  const scoreEl = $('.score', el);
  const clockEl = $('.clock', el);
  const barEl = $('.timer i', el);
  const countEl = $('.count', el);
  const lastEl = $('.last', el);
  const cd = $('.countdown', el);

  let alive = true;
  teardown.push(() => { alive = false; });

  const sol = await solutions(board);
  const found = new Map((resume?.words || []).map((w) => [w.w, w]));
  let attempts = resume?.attempts || 0;
  let score = G.rawPoints(resume);
  let running = false;
  let startedAt = resume?.startedAt;
  let path = [];
  let centers = [];
  let pointer = null;
  const words = () => [...found.values()];

  function paintFound() {
    scoreEl.textContent = fmt(score);
    countEl.textContent = `${found.size} ${found.size === 1 ? 'word' : 'words'}`;
    const lastWord = words().at(-1);
    lastEl.textContent = lastWord ? lastWord.w.toUpperCase() : '';
  }
  paintFound();

  // The server's copy wins: it adds words saved from another tab and replaces
  // the points and path of any word another tab saved first. Words this tab
  // found since the save went out stay at the end until the next save.
  function merge(saved) {
    if (!saved || !alive) return;
    const pending = words().filter((w) => !saved.words.some((s) => s.w === w.w));
    found.clear();
    for (const w of [...saved.words, ...pending]) found.set(w.w, w);
    attempts = Math.max(attempts, saved.attempts);
    score = words().reduce((sum, w) => sum + w.p, 0);
    paintFound();
  }
  const sync = () => Promise.resolve(save(words(), attempts)).then(merge);

  if (!startedAt) {
    el.classList.add('pre');
    for (const n of ['3', '2', '1']) {
      cd.textContent = n;
      cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop');
      sfx.tick(Number(n));
      await new Promise((res) => setTimeout(res, 600));
      if (!alive) return;
    }
    try { startedAt = await start(); } catch (err) { toast(err.message); return go(leave); }
    if (!alive) return;
    sfx.go();
  }
  cd.remove();
  el.classList.remove('pre');
  running = true;

  // Clock
  const tick = () => {
    if (!alive) return;
    const left = startedAt + G.ROUND_MS - now();
    const secs = Math.max(0, Math.ceil(left / 1000));
    clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    barEl.style.transform = `scaleX(${Math.max(0, left / G.ROUND_MS)})`;
    el.classList.toggle('urgent', left < 10_000);
    if (left <= 0) return finish();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  async function finish() {
    if (!running) return;
    running = false;
    clear();
    sfx.end();
    el.classList.add('over');
    $('.word', el).classList.add('timeup');
    lettersEl.textContent = 'Time';
    hintEl.textContent = '';
    await new Promise((res) => setTimeout(res, 900));
    if (alive) end(words(), attempts);
  }

  // Swipe input
  const measure = () => {
    const b = boardEl.getBoundingClientRect();
    centers = tiles.map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, px: r.left - b.left + r.width / 2, py: r.top - b.top + r.height / 2, rad: r.width * 0.44 };
    });
  };

  const hit = (x, y) => {
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      if ((x - c.x) ** 2 + (y - c.y) ** 2 < c.rad ** 2) return i;
    }
    return -1;
  };

  function state(word) {
    if (word.length < 3) return '';
    if (found.has(word)) return 'dup';
    return sol.has(word) ? 'good' : 'bad';
  }

  function paintPath() {
    const word = G.pathWord(board, path);
    const st = state(word);
    boardEl.dataset.state = st;
    $('.word', el).dataset.state = st;
    $('.word', el).classList.remove('flash-good', 'flash-bad', 'flash-dup', 'flash-long', 'timeup');
    tiles.forEach((t, i) => t.classList.toggle('on', path.includes(i)));
    line.setAttribute('points', path.map((i) => `${centers[i].px},${centers[i].py}`).join(' '));
    lettersEl.textContent = word.toUpperCase();
    hintEl.textContent = st === 'good' ? `+${fmt(G.pathPoints(board, path))}` : st === 'dup' ? 'found' : '';
  }

  function step(x, y) {
    const i = hit(x, y);
    if (i < 0 || path.at(-1) === i) return;
    if (path.at(-2) === i) { path.pop(); paintPath(); return; }
    if (path.includes(i)) return;
    if (path.length && !G.ADJ[path.at(-1)].includes(i)) return;
    path.push(i);
    sfx.tick(path.length - 1);
    paintPath();
  }

  function clear() {
    path = [];
    pointer = null;
    boardEl.dataset.state = '';
    tiles.forEach((t) => t.classList.remove('on'));
    line.setAttribute('points', '');
  }

  function flashTiles(ids, cls) {
    ids.forEach((i) => {
      tiles[i].classList.remove('fl-good', 'fl-bad', 'fl-dup');
      void tiles[i].offsetWidth;
      tiles[i].classList.add(cls);
    });
  }

  function release() {
    const ids = path.slice();
    const word = G.pathWord(board, ids);
    const st = state(word);
    clear();
    const wordEl = $('.word', el);
    wordEl.dataset.state = '';
    if (!st) { lettersEl.textContent = ''; hintEl.textContent = ''; return; }
    wordEl.classList.remove('flash-good', 'flash-bad', 'flash-dup', 'flash-long');
    void wordEl.offsetWidth;
    if (st === 'dup') {
      sfx.dup();
      flashTiles(ids, 'fl-dup');
      wordEl.classList.add('flash-dup');
      hintEl.textContent = 'found';
      return;
    }
    attempts++;
    if (st === 'bad') {
      sfx.miss();
      buzz(30);
      flashTiles(ids, 'fl-bad');
      wordEl.classList.add('flash-bad');
      hintEl.textContent = '';
      sync();
      return;
    }
    const p = G.pathPoints(board, ids);
    found.set(word, { w: word, p, path: ids });
    score += p;
    const long = word.length >= G.LONG_WORD;
    if (long) { sfx.long(); buzz([15, 40, 15]); } else { sfx.word(); buzz(12); }
    flashTiles(ids, 'fl-good');
    wordEl.classList.add(long ? 'flash-long' : 'flash-good');
    hintEl.textContent = `+${fmt(p)}`;
    paintFound();
    floatPoints(p, ids, long);
    sync();
  }

  function floatPoints(p, ids, long) {
    const c = centers[ids.at(-1)];
    const f = document.createElement('span');
    f.className = `float${long ? ' long' : ''}`;
    f.textContent = `+${fmt(p)}`;
    f.style.left = `${c.px}px`;
    f.style.top = `${c.py}px`;
    boardEl.appendChild(f);
    f.addEventListener('animationend', () => f.remove());
  }

  boardEl.addEventListener('pointerdown', (e) => {
    if (!running || pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    boardEl.setPointerCapture(e.pointerId);
    measure();
    path = [];
    step(e.clientX, e.clientY);
  });
  boardEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer || !running) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) step(ev.clientX, ev.clientY);
  });
  const up = (e) => { if (e.pointerId === pointer && running) release(); };
  boardEl.addEventListener('pointerup', up);
  boardEl.addEventListener('pointercancel', up);
  boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

  const onHide = () => { if (document.visibilityState === 'hidden' && running) sync(); };
  document.addEventListener('visibilitychange', onHide);
  teardown.push(() => document.removeEventListener('visibilitychange', onHide));
}

// ---------- round result ----------

async function renderResult({ match, r, solo }) {
  const board = solo ? solo.board : match.boards[r];
  const s = solo ? null : G.summarize(match, me, now());
  const x = s?.rounds[r];
  const mine = solo ? solo.play : x.mine;
  const next = s && s.next >= 0 ? `#/m/${match.id}/r/${s.next}` : null;
  const back = solo ? '#/' : `#/m/${match.id}`;
  const title = solo ? 'Solo' : `Round ${r + 1}`;

  const el = screen('result', `
    <header class="bar"><a class="back" href="${back}" aria-label="Back">‹</a><span class="title">${title}</span><span></span></header>
    <div class="body"></div>`);
  const body = $('.body', el);
  const sol = await solutions(board);
  const { commonSet } = await dict();
  const possible = G.possibleTotal(sol);

  function paint(xr) {
    const points = G.rawPoints(mine);
    const acc = G.accuracy(mine);
    const long = G.longest(mine);
    let versus = '';
    if (!solo) {
      versus = xr.them
        ? `<p class="versus ${xr.winner ? `v-${xr.winner}` : ''}">${esc(s.opp)} <b>${fmt(xr.them.points)}</b></p>`
        : `<p class="versus">Waiting for ${esc(s.opp)}</p>`;
    }
    const myWords = (xr?.me ? xr.me.words : mine.words).slice().sort((a, b) => b.p - a.p);
    const shared = myWords.some((w) => w.shared);
    const chips = (list, cls = '') => list.map((w) =>
      `<span class="chip ${cls} ${w.shared ? 'shared' : ''}">${esc(w.w)}<b>${fmt(w.p)}</b></span>`).join('');
    const theirUnique = xr?.them ? xr.them.words.filter((w) => !w.shared).sort((a, b) => b.p - a.p) : [];
    const have = new Set([...mine.words, ...(xr?.them?.words || [])].map((w) => w.w));
    const missed = [...sol.entries()].filter(([w]) => commonSet.has(w) && !have.has(w)).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 8).map(([w, p]) => ({ w, p }));

    body.innerHTML = `
      <div class="headline">
        <span class="big">${fmt(points)}</span>
        ${versus}
      </div>
      <dl class="stats">
        <div><dt>Words</dt><dd>${mine.words.length}<small>/${sol.size}</small></dd></div>
        <div><dt>Accuracy</dt><dd>${acc == null ? '—' : `${acc}%`}</dd></div>
        <div><dt>Longest</dt><dd class="lw">${long ? esc(long.toUpperCase()) : '—'}</dd></div>
        <div><dt>Possible</dt><dd>${fmt(possible)}</dd></div>
      </dl>
      ${myWords.length ? `<section class="words"><h2>Yours${shared ? `<span class="key"><i></i>also found by ${esc(s.opp)}</span>` : ''}</h2><div class="chips">${chips(myWords)}</div></section>` : ''}
      ${theirUnique.length ? `<section class="words"><h2>Only ${esc(s.opp)}</h2><div class="chips">${chips(theirUnique, 'theirs')}</div></section>` : ''}
      ${missed.length ? `<section class="words"><h2>Missed</h2><div class="chips">${chips(missed, 'missed')}</div></section>` : ''}
      <div class="cta">${solo
        ? '<a class="btn primary big" href="#/solo" data-again>Play solo again</a>'
        : next ? `<a class="btn primary big" href="${next}">Round ${s.next + 1}</a>` : `<a class="btn quiet big" href="${back}">Scorecard</a>`}</div>`;
    const again = $('[data-again]', body);
    if (again) again.onclick = (e) => { e.preventDefault(); go('#/solo'); };
  }
  paint(x);

  if (!solo && !x.settled) {
    every(3000, async () => {
      try {
        const { match: m } = await api(`match/${match.id}?me=${encodeURIComponent(me)}`);
        const xr = G.summarize(m, me, now()).rounds[r];
        if (xr.settled) { s.opp = G.summarize(m, me, now()).opp; paint(xr); teardown.forEach((f) => f()); teardown = []; }
      } catch {}
    });
  }
}

route();
