// Pure game rules shared by the phone client and both servers.

export const ROUNDS = 3;
export const ROUND_MS = 90_000;
export const GRACE_MS = 5_000;
export const SIZE = 4;
export const LONG_WORD = 6;
const MIN_COMMON = 45;

// Classic 16-dice set. The Q face plays as "Qu".
const DICE = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS', 'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW', 'EIOSST', 'ELRTTY', 'HIMNUQ', 'HLNNRZ',
];

export const ADJ = Array.from({ length: SIZE * SIZE }, (_, i) => {
  const r = Math.floor(i / SIZE), c = i % SIZE, out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const rr = r + dr, cc = c + dc;
    if ((dr || dc) && rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) out.push(rr * SIZE + cc);
  }
  return out;
});

export function basePoints(len) {
  if (len < 3) return 0;
  return [0, 0, 0, 10, 20, 40, 60, 90, 120][len] ?? 120 + (len - 8) * 40;
}

export const pathWord = (board, path) => path.map((i) => board.tiles[i]).join('');
export const pathMult = (board, path) => path.reduce((m, i) => m * board.mult[i], 1);
export const pathPoints = (board, path) => basePoints(pathWord(board, path).length) * pathMult(board, path);

function rollBoard(rand) {
  const dice = DICE.slice();
  for (let i = dice.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [dice[i], dice[j]] = [dice[j], dice[i]];
  }
  const tiles = dice.map((d) => {
    const ch = d[Math.floor(rand() * 6)].toLowerCase();
    return ch === 'q' ? 'qu' : ch;
  });
  const open = tiles.map((t, i) => i).filter((i) => tiles[i] !== 'qu');
  const x2 = open.splice(Math.floor(rand() * open.length), 1)[0];
  const x3 = open.splice(Math.floor(rand() * open.length), 1)[0];
  const mult = tiles.map(() => 1);
  mult[x2] = 2;
  mult[x3] = 3;
  return { tiles, mult };
}

// Best multiplier any path spelling `w` can reach, or 0 when the board cannot spell it.
function bestMult(board, w) {
  let best = 0;
  const { tiles, mult } = board;
  const dfs = (i, pos, used, m) => {
    if (pos === w.length) { if (m > best) best = m; return; }
    for (const j of ADJ[i]) {
      if (used & (1 << j)) continue;
      const t = tiles[j];
      if (w.startsWith(t, pos)) dfs(j, pos + t.length, used | (1 << j), m * mult[j]);
    }
  };
  for (let i = 0; i < tiles.length; i++) {
    if (w.startsWith(tiles[i], 0)) dfs(i, tiles[i].length, 1 << i, mult[i]);
  }
  return best;
}

// Every dictionary word the board can spell, mapped to its best possible points.
export function solve(board, words) {
  const have = new Uint8Array(26);
  for (const t of board.tiles) for (const ch of t) have[ch.charCodeAt(0) - 97]++;
  const need = new Uint8Array(26);
  const out = new Map();
  outer: for (const w of words) {
    need.fill(0);
    for (let k = 0; k < w.length; k++) {
      const c = w.charCodeAt(k) - 97;
      if (++need[c] > have[c]) continue outer;
    }
    const m = bestMult(board, w);
    if (m) out.set(w, basePoints(w.length) * m);
  }
  return out;
}

// words.txt lists common words first, then "--", then the rest of the accepted words.
export function parseDict(text) {
  const lines = text.split('\n');
  const cut = lines.indexOf('--');
  const common = lines.slice(0, cut).filter(Boolean);
  return { words: lines.filter((w) => w && w !== '--'), common, commonSet: new Set(common) };
}

// Rerolls until the board holds enough familiar words to be fun.
export function makeBoard(dict, rand = Math.random) {
  let best = null;
  for (let tries = 0; tries < 30; tries++) {
    const board = rollBoard(rand);
    const n = solve(board, dict.common).size;
    if (!best || n > best.n) best = { board, n };
    if (n >= MIN_COMMON) break;
  }
  return best.board;
}

export function possibleTotal(solutions) {
  let sum = 0;
  for (const p of solutions.values()) sum += p;
  return sum;
}

// A round is over once it was submitted or its clock (plus grace) ran out.
export function roundDone(play, now) {
  return !!play && (!!play.endedAt || (!!play.startedAt && now >= play.startedAt + ROUND_MS + GRACE_MS));
}

export function rawPoints(play) {
  return play ? play.words.reduce((s, w) => s + w.p, 0) : 0;
}

export function accuracy(play) {
  if (!play || !play.attempts) return null;
  return Math.round((100 * play.words.length) / play.attempts);
}

export function longest(play) {
  return play ? play.words.reduce((a, w) => (w.w.length > a.length ? w.w : a), '') : '';
}

// Once both players are done, a round compares raw points. Every word keeps its full points;
// `shared` only marks words the opponent also found.
export function settleRound(match, r, now) {
  const [a, b] = [match.plays[0][r], match.plays[1][r]];
  if (!roundDone(a, now) || !roundDone(b, now)) return null;
  const sets = [new Set(a.words.map((w) => w.w)), new Set(b.words.map((w) => w.w))];
  return [a, b].map((play, i) => ({
    points: rawPoints(play),
    words: play.words.map((w) => ({ ...w, shared: sets[1 - i].has(w.w) })),
  }));
}

// Everything the UI needs about a match from one player's point of view.
export function summarize(match, me, now) {
  const mi = match.players.indexOf(me);
  const oi = 1 - mi;
  const rounds = [];
  const won = [0, 0];
  const totals = [0, 0];
  let next = -1;
  for (let r = 0; r < ROUNDS; r++) {
    const mine = match.plays[mi][r];
    const theirs = match.plays[oi][r];
    const myDone = roundDone(mine, now);
    const theirDone = roundDone(theirs, now);
    const settled = settleRound(match, r, now);
    if (!myDone && next === -1) next = r;
    let winner = null;
    if (settled) {
      totals[0] += settled[mi].points;
      totals[1] += settled[oi].points;
      if (settled[mi].points !== settled[oi].points) {
        winner = settled[mi].points > settled[oi].points ? 'me' : 'them';
        won[winner === 'me' ? 0 : 1]++;
      }
    }
    rounds.push({
      r, mine, theirs, myDone, theirDone, settled,
      me: settled?.[mi] ?? null,
      them: settled?.[oi] ?? null,
      raw: rawPoints(mine),
      live: !!mine && !myDone,
      winner,
    });
  }
  const done = match.status === 'active' && rounds.every((x) => x.settled);
  let result = null;
  if (done) {
    if (won[0] !== won[1]) result = won[0] > won[1] ? 'win' : 'loss';
    else if (totals[0] !== totals[1]) result = totals[0] > totals[1] ? 'win' : 'loss';
    else result = 'tie';
  }
  return {
    opp: match.players[oi], mi, oi, rounds, next, won, totals, done, result,
    invitedMe: match.status === 'invited' && mi === 1,
    pendingThem: match.status === 'invited' && mi === 0,
  };
}
