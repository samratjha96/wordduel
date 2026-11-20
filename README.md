# Wordduel

A two-player swipe word game for phones. Both players get the same three 4×4 boards and play each 90-second round whenever they like. Each round is decided once both have played it.

## Play on your home network

Requires Node 20 or newer. There are no runtime dependencies.

```sh
cd ~/Documents/scratch/wordduel
PORT=5121 node server/node.js
```

The server prints a `phones:` URL such as `http://192.168.1.20:5121`. Open it on both phones while they are on the same Wi-Fi. Each player picks a username. One taps Play against someone, types the other's username and taps Start game, and the other accepts from their home screen. Play solo starts a single board on your own. Solo games aren't saved.

Game state is saved in `data/db.json`. Stop the server with Ctrl-C. Your history is still there after a restart.

## Rules

- Swipe through touching tiles, including diagonals. You can't use a tile twice in one word. Words need at least 3 letters.
- Points by word length: 3 letters 10, 4 letters 20, 5 letters 40, 6 letters 60, 7 letters 90, 8 letters 120, then 40 for each extra letter.
- A word that passes through a 2× or 3× tile has its points multiplied. When a word goes through both, the multipliers stack.
- Every word keeps its full points, even when your opponent found it too. Your score is the same on the play screen, the round result, the scorecard and in history. Round results mark words your opponent also found.
- A round is decided once both players have played it.
- The match goes to whoever wins more of the 3 rounds. If rounds are tied, total points decide it.
- When you finish round 3 the scorecard opens. If your opponent is still playing, it shows their progress and fills in the winner when they finish.
- Tap Rematch on a finished scorecard to start a new match with new boards against the same opponent. Their scorecard then offers the same rematch, and tapping it joins it. However many times either of you taps, there is only one rematch per match, and the old match stays in history.
- Accuracy is your valid words divided by your attempts. Swiping a word you already found doesn't count as an attempt.
- Each round result shows how many words the board held and its total possible points. It also shows your longest word and the best common words you missed.

The dictionary merges two lists, about 274k words in all: [word-list](https://github.com/sindresorhus/word-list) (MIT) and [ENABLE](https://github.com/dolph/dictionary/blob/master/enable1.txt) (public domain). word-list leaves out adult and profane words; ENABLE, the standard word-game list, puts them back, so words like lust, porn and tits are valid. Words from [SCOWL](http://wordlist.aspell.net/) (size 50 and under) are marked as common. Common words decide whether a board is good enough and which words show under "Missed". See `public/words.LICENSE.txt`.

## Deploy to Cloudflare

The same API runs in one Durable Object on SQLite storage, and Workers Static Assets serves `public/`. This fits within the Workers free plan.

```sh
cd ~/Documents/scratch/wordduel
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the `*.workers.dev` URL. Open it on both phones. To run the Cloudflare build locally first, use `npx wrangler dev`.

## Layout

| Path | What it is |
| --- | --- |
| `public/` | The phone app. Board generation, solving and scoring run here in `game.js`. |
| `public/words.txt` | Dictionary. Common words come first, then `--`, then the rest. |
| `server/api.js` | JSON API over a small key-value store. Shared by both servers. Phones send swipe paths; the API checks each path and word against the board and dictionary, scores it, and only ever adds words. It accepts only same-origin JSON posts. |
| `server/node.js` | LAN server: static files, the API, and the `data/db.json` store. |
| `worker/index.js` | Cloudflare Worker entry and the `Game` Durable Object. |
| `wrangler.jsonc` | Cloudflare config. |
