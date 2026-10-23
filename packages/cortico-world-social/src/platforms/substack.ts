/**
 * Substack through the JSON its own pages read, fetched from a page on the same address so a request
 * carries the browser's cookies: a publication's posts (newest or most liked first), a person's Notes
 * and posts (the person's own with `me`), the home feed, and the publications on a category's
 * leaderboard with the most liked of their recent posts. Notes, comments on posts and post drafts are
 * written the same way. Reading is public apart from `me`; writing needs a login.
 */
import type { FetchedText, PageSession } from '../browser.ts';
import { PlatformBlocked, type Collector } from '../collect.ts';
import { CommentRefused } from '../comments.ts';
import type { Post } from '../posts.ts';
import { hostIs, type Adapter, type BrowseRequest } from './adapter.ts';
import {
  SUBSTACK_ORIGIN, findCategory, markdownDoc, noteDoc, noteUrl, onSubstack, parseSubstackArchive, parseSubstackCategories, parseSubstackComments,
  parseSubstackFeed, parseSubstackLeaderboard, parseSubstackSelf, profileHandle, publicationAddress, substackPost,
} from './substack-parse.ts';

/** Posts per archive page; Substack answers larger pages short. */
const PAGE = 12;
/** Pages of a reader feed read for one listing. */
const FEED_PAGES = 5;
/** Publications of a leaderboard looked at for one listing. */
const LEADERS = 10;
/** The most liked recent posts taken from each of them. */
const PER_PUBLICATION = 2;
/** A leaderboard's orders, as the tool names them, to the ones Substack's own page asks for. */
const RANKS: Record<string, string> = { rising: 'trending', paid: 'paid' };
/** A person's feed narrowed to one kind, as the tool names it, to Substack's `types[]`. */
const PROFILE_TYPES: Record<string, string> = { notes: 'note', posts: 'post' };
const JSON_HEADERS = { 'content-type': 'application/json' };
/** The line automatic comments and Notes end with while they are marked (`cfg.comments.sign`). */
export const SUBSTACK_AUTO_NOTE = '(Sent automatically by my assistant.)';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** A page at `origin` to fetch from, and the origin it ends on: a publication may move to its own domain. */
async function on(page: PageSession, origin: string): Promise<string> {
  const at = page.url().startsWith(`${origin}/`) ? page.url() : await page.goto(`${origin}/robots.txt`);
  return new URL(at).origin;
}

async function getJson(page: PageSession, url: string): Promise<unknown> {
  const rep = await page.fetchText(url);
  if (rep.status === 401 || rep.status === 403) throw new PlatformBlocked('substack', 'login');
  if (rep.status === 429) throw new PlatformBlocked('substack', 'blocked', 'HTTP 429, too many requests');
  if (rep.status === 404) return null;
  if (rep.status >= 400) throw new PlatformBlocked('substack', 'blocked', `HTTP ${rep.status}`);
  try {
    return JSON.parse(rep.text);
  } catch {
    // an HTML answer is a login or block page
    throw new PlatformBlocked('substack', 'blocked', 'the answer was not JSON');
  }
}

/** The post a link names (`/p/<slug>` on a substack.com address): its publication's address and slug. */
export function substackPostRef(url: string): { origin: string; slug: string } | null {
  try {
    const u = new URL(url);
    const slug = /^\/p\/([^/?#]+)/.exec(u.pathname)?.[1];
    return (u.protocol === 'https:' || u.protocol === 'http:') && hostIs(u, 'substack.com') && slug ? { origin: u.origin, slug } : null;
  } catch {
    return null;
  }
}

/** The Note a link names (`/note/c-<id>` on substack.com), by its number. */
export function substackNoteId(url: string): number | null {
  try {
    const u = new URL(url);
    const id = /\/note\/c-(\d+)/.exec(u.pathname)?.[1];
    return (u.protocol === 'https:' || u.protocol === 'http:') && hostIs(u, 'substack.com') && id ? Number(id) : null;
  } catch {
    return null;
  }
}

/** The account logged in; throws a login block without one. */
export async function substackSelf(page: PageSession): Promise<{ id: number; handle: string; name: string }> {
  await on(page, SUBSTACK_ORIGIN);
  const self = parseSubstackSelf(await getJson(page, `${SUBSTACK_ORIGIN}/api/v1/user/profile/self`));
  if (!self) throw new PlatformBlocked('substack', 'login');
  return self;
}

/** A person's id by handle; throws when Substack knows no such person. */
async function profileId(page: PageSession, handle: string): Promise<number> {
  await on(page, SUBSTACK_ORIGIN);
  const person = parseSubstackSelf(await getJson(page, `${SUBSTACK_ORIGIN}/api/v1/user/${encodeURIComponent(handle)}/public_profile`));
  if (!person) throw new Error(`Substack has no account @${handle}`);
  return person.id;
}

/** A publication's archive; its posts are linked at `origin` when that is a substack.com address, else where it led. */
async function listArchive(page: PageSession, origin: string, sort: 'new' | 'top', collector: Collector): Promise<void> {
  const at = await on(page, origin);
  for (let offset = 0; !collector.done; offset += PAGE) {
    const posts = parseSubstackArchive(await getJson(page, `${at}/api/v1/archive?sort=${sort}&offset=${offset}&limit=${PAGE}`), onSubstack(origin) ? origin : at);
    for (const p of posts) if (!collector.offer(p)) return;
    if (posts.length < PAGE) return;
  }
}

/** A reader feed at `path`, with `query` (`types[]=note`, say), up to `FEED_PAGES` pages. */
async function listFeed(page: PageSession, path: string, query: string, collector: Collector): Promise<void> {
  await on(page, SUBSTACK_ORIGIN);
  let cursor: string | undefined;
  for (let i = 0; i < FEED_PAGES && !collector.done; i++) {
    const params = [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&');
    const json = await getJson(page, `${SUBSTACK_ORIGIN}${path}${params ? `?${params}` : ''}`);
    for (const p of parseSubstackFeed(json)) if (!collector.offer(p)) return;
    cursor = str(obj(json)?.nextCursor);
    if (!cursor) return;
  }
}

/** An account listing: the person's own Notes and posts for `me`, a person's for `@handle`, else a publication's posts. */
async function listAccount(page: PageSession, req: BrowseRequest, collector: Collector): Promise<void> {
  const origin = publicationAddress(req.query);
  if (origin) return listArchive(page, origin, req.sort === 'top' ? 'top' : 'new', collector);
  const handle = profileHandle(req.query);
  if (!handle && req.query.trim().toLowerCase() !== 'me') throw new Error(`"${req.query}" names no Substack publication or person; give a publication (its name or address), @handle, or me`);
  const id = handle ? await profileId(page, handle) : (await substackSelf(page)).id;
  const type = PROFILE_TYPES[req.sort ?? ''];
  return listFeed(page, `/api/v1/reader/feed/profile/${id}`, type ? `types%5B%5D=${type}` : '', collector);
}

const likes = (p: Post): number => Number(p.stats.find(([k]) => k === 'likes')?.[1] ?? 0);

/** The publications leading a category's leaderboard, each with the most liked of its recent posts. */
async function listLeaders(page: PageSession, query: string, rank: string, collector: Collector): Promise<void> {
  await on(page, SUBSTACK_ORIGIN);
  const categories = parseSubstackCategories(await getJson(page, `${SUBSTACK_ORIGIN}/api/v1/categories`));
  const category = findCategory(categories, query);
  if (!category) throw new Error(`no Substack category is named "${query}"; some are ${categories.slice(0, 12).map((c) => c.name).join(', ')}`);
  const leaders = parseSubstackLeaderboard(await getJson(page, `${SUBSTACK_ORIGIN}/api/v1/category/leaderboard/${category.id}/${RANKS[rank]}?page=0`)).slice(0, LEADERS);
  for (const pub of leaders) {
    if (collector.done) return;
    try {
      const at = await on(page, pub.origin);
      const recent = parseSubstackArchive(await getJson(page, `${at}/api/v1/archive?sort=new&offset=0&limit=${PAGE}`), pub.origin);
      for (const p of recent.filter((x) => !x.video).sort((a, b) => likes(b) - likes(a)).slice(0, PER_PUBLICATION)) {
        if (!collector.offer({ ...p, community: pub.name })) return;
      }
    } catch (err) {
      // one publication that refuses leaves the others
      if (!(err instanceof PlatformBlocked && err.kind === 'blocked')) throw err;
    }
  }
}

/** The leaderboard a community listing reads: the best-selling with `paid`, else the rising. */
const rankFor = (req: BrowseRequest): string => (req.sort === 'paid' ? 'paid' : 'rising');

/** What Substack answered to a write, or the refusal it stands for. */
function written(rep: FetchedText): Record<string, unknown> {
  if (rep.status === 401 || rep.status === 403) throw new PlatformBlocked('substack', 'login');
  if (rep.status === 429) throw new PlatformBlocked('substack', 'blocked', 'HTTP 429, too many requests');
  let json: unknown;
  try {
    json = JSON.parse(rep.text);
  } catch {
    json = undefined;
  }
  if (rep.status >= 400) throw new CommentRefused('substack', str(obj(json)?.error) ?? `HTTP ${rep.status}`);
  return obj(json) ?? {};
}

/** Posts a Note, or a reply to the Note `parentId`, with the browser's login; the Note's link when Substack names it. */
export async function postSubstackNote(page: PageSession, text: string, parentId?: number): Promise<{ link: string | null }> {
  const self = await substackSelf(page);
  const body = { bodyJson: noteDoc(text), replyMinimumRole: 'everyone', tabId: 'for-you', surface: 'feed', ...(parentId ? { parent_id: parentId } : {}) };
  const answer = written(await page.fetchText(`${SUBSTACK_ORIGIN}/api/v1/comment/feed`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }));
  const id = num(answer.id);
  return { link: id ? noteUrl(self.handle, id) : null };
}

/** Posts a comment on the post at `url` with the browser's login; the comment's link when Substack names it. */
export async function postSubstackComment(page: PageSession, url: string, text: string): Promise<{ link: string | null }> {
  const ref = substackPostRef(url);
  if (!ref) throw new CommentRefused('substack', 'not a post link');
  const at = await on(page, ref.origin);
  const postId = num(obj(await getJson(page, `${at}/api/v1/posts/${encodeURIComponent(ref.slug)}`))?.id);
  if (postId === undefined) throw new CommentRefused('substack', 'the post was not found');
  const answer = written(await page.fetchText(`${at}/api/v1/post/${postId}/comment`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body: text }) }));
  const id = num(answer.id);
  return { link: id ? `${at}/p/${ref.slug}/comment/${id}` : null };
}

/**
 * Creates a draft post, by the account logged in, in the publication at `origin`; nothing publishes
 * it. The body is Markdown (`markdownDoc`). Returns the draft's link in Substack's editor.
 */
export async function createSubstackDraft(page: PageSession, origin: string, draft: { title: string; subtitle: string; body: string }): Promise<{ link: string }> {
  const self = await substackSelf(page);
  const at = await on(page, origin);
  const answer = written(await page.fetchText(`${at}/api/v1/drafts`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      draft_title: draft.title,
      draft_subtitle: draft.subtitle,
      // the editor's document goes as a string, inside the JSON
      draft_body: JSON.stringify(markdownDoc(draft.body)),
      draft_bylines: [{ id: self.id, is_guest: false }],
      audience: 'everyone',
      type: 'newsletter',
    }),
  }));
  const id = num(answer.id);
  if (id === undefined) throw new CommentRefused('substack', 'the answer named no draft');
  return { link: `${at}/publish/post/${id}` };
}

export const SUBSTACK: Adapter = {
  id: 'substack',
  loginUrl: `${SUBSTACK_ORIGIN}/sign-in`,
  // Substack sets its session cookie for visitors too; `loggedIn` asks who is logged in
  session: { domain: '.substack.com', cookies: ['substack.sid'] },
  sources: ['feed', 'account', 'community'],

  async list(page, req, collector) {
    if (req.source === 'feed') return listFeed(page, '/api/v1/reader/feed', '', collector);
    if (req.source === 'community') return listLeaders(page, req.query, rankFor(req), collector);
    if (req.source === 'account') return listAccount(page, req, collector);
  },

  applied: (req) => {
    if (req.source === 'community') return { sort: rankFor(req) };
    if (req.source !== 'account') return {};
    if (publicationAddress(req.query)) return { sort: req.sort === 'top' ? 'top' : 'new' };
    return { sort: PROFILE_TYPES[req.sort ?? ''] ? req.sort : undefined };
  },

  owns: (url) => hostIs(url, 'substack.com'),

  async read(page, url, maxComments) {
    const ref = substackPostRef(url);
    if (!ref) return null;
    const at = await on(page, ref.origin);
    const json = obj(await getJson(page, `${at}/api/v1/posts/${encodeURIComponent(ref.slug)}`));
    if (!json) return null;
    const id = num(json.id);
    const comments = id !== undefined && maxComments > 0
      ? parseSubstackComments(await getJson(page, `${at}/api/v1/post/${id}/comments?all_comments=true&sort=best_first`), maxComments)
      : [];
    // linked at the address the link named, which `owns` keeps readable when it leads to the publication's own domain
    return { post: substackPost(json, ref.origin), comments };
  },

  async loggedIn(page) {
    try {
      await substackSelf(page);
      return true;
    } catch (err) {
      if (err instanceof PlatformBlocked) return false;
      throw err;
    }
  },
};
