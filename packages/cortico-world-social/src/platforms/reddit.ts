/**
 * Reddit through its JSON listings, fetched from a reddit.com page so the request carries the
 * browser's cookies: the front page, a subreddit, a search, a user's posts, and a post's comments.
 * Reddit serves the listings only to logged-in visitors.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, type Collector } from '../collect.ts';
import { accountName, hostIs, type Adapter, type BrowseRequest } from './adapter.ts';
import { parseRedditListing, parseRedditThread } from './reddit-parse.ts';

const ORIGIN = 'https://www.reddit.com';
const PAGE_MAX = 100;
const LISTING_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
const SEARCH_SORTS = new Set(['relevance', 'top', 'new', 'comments', 'hot']);
const PERIODS = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

/** A page on reddit.com to fetch from; robots.txt is small and needs no script. */
async function onReddit(page: PageSession): Promise<void> {
  if (!page.url().startsWith(ORIGIN)) await page.goto(`${ORIGIN}/robots.txt`);
}

/** Whether Reddit knows the visitor: its account endpoint names the logged-in account. */
async function loggedIn(page: PageSession): Promise<boolean> {
  const rep = await page.fetchText(`${ORIGIN}/api/me.json`);
  try {
    const me = JSON.parse(rep.text) as { name?: unknown; data?: { name?: unknown } };
    return rep.status === 200 && typeof (me.data?.name ?? me.name) === 'string';
  } catch {
    return false;
  }
}

async function getJson(page: PageSession, path: string): Promise<unknown> {
  const rep = await page.fetchText(`${ORIGIN}${path}`);
  // a refusal is a missing login, unless the visitor is logged in (a private or banned subreddit)
  if (rep.status === 401 || rep.status === 403) {
    if (rep.status === 403 && await loggedIn(page)) throw new PlatformBlocked('reddit', 'blocked', `HTTP ${rep.status}`);
    throw new PlatformBlocked('reddit', 'login');
  }
  if (rep.status === 429) throw new PlatformBlocked('reddit', 'blocked', 'HTTP 429, too many requests');
  if (rep.status === 404) return null;
  if (rep.status >= 400) throw new PlatformBlocked('reddit', 'blocked', `HTTP ${rep.status}`);
  try {
    return JSON.parse(rep.text);
  } catch {
    // an HTML answer is Reddit's block or login page
    throw new PlatformBlocked('reddit', 'blocked', 'the answer was not a listing');
  }
}

/** The order a listing uses for `req`; Reddit's own default when it names none Reddit knows. */
function sortFor(req: BrowseRequest): string | undefined {
  if (req.source === 'search') return req.sort && SEARCH_SORTS.has(req.sort) ? req.sort : 'relevance';
  if (req.sort && LISTING_SORTS.has(req.sort)) return req.sort;
  return req.source === 'community' ? 'hot' : req.source === 'account' ? 'new' : undefined;
}

/** Reddit ranks by a period only for search and the top and controversial orders. */
function periodFor(req: BrowseRequest): string | undefined {
  const sort = sortFor(req);
  const ranked = req.source === 'search' || sort === 'top' || sort === 'controversial';
  return ranked && req.period && PERIODS.has(req.period) ? req.period : undefined;
}

/** The listing path for a request, before `limit` and `after`. */
export function redditListingPath(req: BrowseRequest): string | null {
  const period = periodFor(req);
  const sort = sortFor(req);
  const q = new URLSearchParams({ raw_json: '1' });
  if (period) q.set('t', period);
  switch (req.source) {
    case 'feed':
      // the front page: the person's own when logged in, popular posts otherwise
      return sort ? `/${sort}.json?${q}` : `/.json?${q}`;
    case 'community': {
      const name = req.query.trim().replace(/^\/?r\//i, '').split(/[/?#\s]/)[0];
      if (!name) return null;
      return `/r/${encodeURIComponent(name)}/${sort}.json?${q}`;
    }
    case 'search': {
      if (!req.query.trim()) return null;
      q.set('q', req.query.trim());
      q.set('sort', sort!);
      return `/search.json?${q}`;
    }
    case 'account': {
      const name = accountName(req.query);
      if (!name) return null;
      q.set('sort', sort!);
      return `/user/${encodeURIComponent(name)}/submitted.json?${q}`;
    }
  }
}

export const REDDIT: Adapter = {
  id: 'reddit',
  loginUrl: `${ORIGIN}/login/`,
  session: { domain: '.reddit.com', cookies: ['reddit_session'] },
  sources: ['feed', 'search', 'account', 'community'],

  async list(page, req, collector: Collector) {
    const path = redditListingPath(req);
    if (!path) return;
    await onReddit(page);
    let after: string | null = null;
    do {
      const limit = Math.min(PAGE_MAX, Math.max(10, collector.want - collector.posts.length + 5));
      const json = await getJson(page, `${path}&limit=${limit}${after ? `&after=${after}` : ''}`);
      if (!json) return;
      const listing = parseRedditListing(json);
      for (const p of listing.posts) if (!collector.offer(p)) return;
      after = listing.after;
    } while (after && !collector.done);
  },

  applied: (req) => ({ sort: sortFor(req), period: periodFor(req) }),

  // i.redd.it and v.redd.it hold media, not posts
  owns: (url) => hostIs(url, 'reddit.com') || url.hostname === 'redd.it',

  // the apps' share links (/r/<name>/s/<id>) redirect to the thread
  shareLink: (url) => hostIs(url, 'reddit.com') && /^\/r\/[^/]+\/s\/\w+\/?$/.test(url.pathname),

  async read(page, url, maxComments) {
    const u = new URL(url);
    let path = u.pathname.replace(/\/$/, '');
    // redd.it/<id>, /gallery/<id> and /comments/<id> all name the thread
    if (u.hostname === 'redd.it') path = `/comments${path}`;
    path = path.replace(/^\/gallery\//, '/comments/');
    await onReddit(page);
    const json = await getJson(page, `${path}.json?raw_json=1&sort=top&limit=${Math.max(1, maxComments)}`);
    const { post, comments } = parseRedditThread(json, maxComments);
    return post ? { post, comments } : null;
  },
};
