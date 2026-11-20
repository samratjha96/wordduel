// Cloudflare entry: static files come from Workers Static Assets (public/),
// /api/* goes to a single Durable Object that owns all game state.
import { DurableObject } from 'cloudflare:workers';
import { createApi } from '../server/api.js';
import WORDS from '../public/words.txt';

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.api = createApi({
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      list: async (prefix) => [...(await storage.list({ prefix })).values()],
    }, WORDS);
  }

  fetch(request) {
    return this.api(request);
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return env.GAME.get(env.GAME.idFromName('global')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
