/**
 * Reddit through its JSON listings, fetched from a reddit.com page so the request carries the
 * browser's cookies: the front page, a subreddit, a search, a user's posts, and a post's comments.
 * Reddit serves the listings only to logged-in visitors. A comment goes through the site's own
 * comment endpoint the same way, and the replies to the person come from their inbox.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, type Collector } from '../collect.ts';
import { CommentRefused } from '../comments.ts';
import { accountName, hostIs, type Adapter, type BrowseRequest } from './adapter.ts';
import { parseRedditInbox, parseRedditListing, parseRedditThread, type RedditReply } from './reddit-parse.ts';

const ORIGIN = 'https://www.reddit.com';
const PAGE_MAX = 100;
const LISTING_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
const SEARCH_SORTS = new Set(['relevance', 'top', 'new', 'comments', 'hot']);
const PERIODS = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
/** Reddit's ids of posts and comments, in base 36. */
const THING_ID = /^[a-z0-9]{1,13}$/;

/** The longest comment Reddit takes. */
export const REDDIT_COMMENT_MAX = 10_000;
/** The line an automatic comment ends with when the person has them marked, in Reddit's small print. */
export const AUTO_NOTE = '^(Sent automatically by my assistant.)';
/** The longest comment the bot may write: what Reddit takes, less room for `AUTO_NOTE`. */
export const BOT_COMMENT_MAX = REDDIT_COMMENT_MAX - AUTO_NOTE.length - 2;

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

/**
 * What a reply to `url` answers: the comment the link names (`t1_<id>`), else its post (`t3_<id>`);
 * null for a link that names neither, a share link among them, and for one that is no http(s) link.
 */
export function redditReplyTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const seg = u.pathname.split('/').filter(Boolean).map((x) => x.toLowerCase());
  if (u.hostname === 'redd.it') return THING_ID.test(seg[0] ?? '') ? `t3_${seg[0]}` : null;
  if (!hostIs(u, 'reddit.com')) return null;
  if (seg[0] === 'gallery') return THING_ID.test(seg[1] ?? '') ? `t3_${seg[1]}` : null;
  const at = seg.indexOf('comments');
  const post = at >= 0 ? seg[at + 1] : undefined;
  if (!post || !THING_ID.test(post)) return null;
  // /comments/<post>/<title>/<comment>/, or /comments/<post>/comment/<comment>/
  const comment = seg[at + 3];
  return comment && THING_ID.test(comment) ? `t1_${comment}` : `t3_${post}`;
}

/**
 * Posts `text` as a reply to `target` (`t3_` or `t1_`) with the browser's login, through the site's
 * comment endpoint, which takes the login's modhash from `/api/me.json`. Returns the new comment's
 * link when Reddit names it; throws `CommentRefused` with Reddit's reason when it turns the comment down.
 */
export async function postRedditComment(page: PageSession, target: string, text: string): Promise<{ link: string | null }> {
  await onReddit(page);
  const me = await page.fetchText(`${ORIGIN}/api/me.json`);
  let modhash: unknown;
  try {
    modhash = (JSON.parse(me.text) as { data?: { modhash?: unknown } }).data?.modhash;
  } catch {
    // a login page
  }
  if (typeof modhash !== 'string' || !modhash) throw new PlatformBlocked('reddit', 'login');
  const rep = await page.fetchText(`${ORIGIN}/api/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-modhash': modhash },
    body: new URLSearchParams({ api_type: 'json', raw_json: '1', thing_id: target, text }).toString(),
  });
  if (rep.status === 401) throw new PlatformBlocked('reddit', 'login');
  if (rep.status === 429) throw new PlatformBlocked('reddit', 'blocked', 'HTTP 429, too many requests');
  if (rep.status >= 400) throw new CommentRefused(`HTTP ${rep.status}`);
  let answer: { json?: { errors?: unknown[]; data?: { things?: Array<{ data?: Record<string, unknown> }> } } };
  try {
    answer = JSON.parse(rep.text) as typeof answer;
  } catch {
    throw new PlatformBlocked('reddit', 'blocked', 'the answer was not JSON');
  }
  const errors = Array.isArray(answer.json?.errors) ? answer.json.errors : [];
  // each error is [code, message, field]
  if (errors.length) throw new CommentRefused(errors.map((e) => (Array.isArray(e) ? e.slice(0, 2).filter(Boolean).join(': ') : String(e))).join('; '));
  const d = answer.json?.data?.things?.[0]?.data;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const permalink = str(d?.permalink);
  const id = str(d?.id);
  const post = str(d?.link_id)?.replace(/^t3_/, '');
  return { link: permalink ? ORIGIN + permalink : id && post ? `${ORIGIN}/comments/${post}/_/${id}/` : null };
}

/** The account logged in and the unread replies to its comments and posts, read without marking them read. */
export async function redditInbox(page: PageSession): Promise<{ me: string; replies: RedditReply[] }> {
  await onReddit(page);
  const me = await page.fetchText(`${ORIGIN}/api/me.json`);
  let name: unknown;
  try {
    name = (JSON.parse(me.text) as { data?: { name?: unknown } }).data?.name;
  } catch {
    // a login page
  }
  if (typeof name !== 'string' || !name) throw new PlatformBlocked('reddit', 'login');
  return { me: name, replies: parseRedditInbox(await getJson(page, '/message/unread.json?mark=false&limit=50&raw_json=1')) };
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
