/**
 * X (Twitter) from its pages: the home timeline, search, a profile, and a post with its replies.
 * Replies and posts are typed into X's own composer (`compose`), under the post or on the compose
 * page, and confirmed by X's `CreateTweet` answer, which names the new post.
 */
import type { FetchedText, PageSession } from '../browser.ts';
import { PlatformBlocked, domToPost, scrollCollect } from '../collect.ts';
import { CommentRefused } from '../comments.ts';
import type { Post } from '../posts.ts';
import { DOM_READ_DEFAULTS, readXPosts } from './dom.ts';
import { accountName, hostIs, type Adapter, type NewPost } from './adapter.ts';
import { compose, findKey, jsonOf } from './compose.ts';

const ORIGIN = 'https://x.com';
const READY = 'article[data-testid="tweet"]';

/** X sends a visitor without a login to its login flow. */
function checkLogin(url: string): void {
  const path = new URL(url).pathname;
  if (path.startsWith('/i/flow/login') || path === '/login' || path.startsWith('/i/flow/signup')) throw new PlatformBlocked('x', 'login');
}

/** Larger renditions read better; X serves `small` in timelines. */
const larger = (src: string): string => src.replace(/([?&]name=)(thumb|small|240x240|360x360)\b/, '$1medium');
const withLargerImages = (post: Post): Post => ({ ...post, images: post.images.map((i) => ({ ...i, url: larger(i.url) })) });

/** How many of a post page's tweets come before the recommendations X lists under a heading ("Discover more"). */
function threadLength(): number {
  const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const first = tweets[0];
  const heading = first && Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"] h2, div[data-testid="cellInnerDiv"] [role="heading"]'))
    .find((h) => (first.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  return heading ? tweets.filter((t) => (heading.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).length : tweets.length;
}

async function open(page: PageSession, url: string): Promise<void> {
  checkLogin(await page.goto(url));
}

/** The most a post or a reply may weigh (`xLength`). */
export const X_TEXT_MAX = 280;
/** Code points X counts as one; the others count as two. */
const LIGHT: ReadonlyArray<[number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const LINK = /https?:\/\/\S+/g;

/** A text's weight as X counts it: a link 23, a Latin letter, digit or common punctuation 1, anything else (CJK, emoji) 2. */
export function xLength(text: string): number {
  let n = (text.match(LINK) ?? []).length * 23;
  for (const ch of text.replace(LINK, '')) {
    const c = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2;
  }
  return n;
}

/** What a reply on an X link answers: the post's id. */
export function xReplyTarget(url: URL): string | null {
  if (!hostIs(url, 'x.com', 'twitter.com')) return null;
  return /^\/(?:[^/]+|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
}

/** The composer's box, under a post or in the compose dialog. */
const BOX = '[data-testid="tweetTextarea_0"]';
/** X's requests that send a post or a reply. */
const SENDS = /\/graphql\/[^/]+\/Create\w*Tweet\b/;

/** The new post's link from X's answer; X's own error when it names one instead. */
function linkOf(answer: FetchedText): string | null {
  const json = jsonOf(answer.text) as { errors?: Array<{ message?: unknown }> } | null;
  const id = findKey(json, 'rest_id');
  if (!id && Array.isArray(json?.errors) && json.errors.length) throw new CommentRefused('x', String(json.errors[0]?.message ?? 'X turned it down'));
  return id ? `${ORIGIN}/i/status/${id}` : null;
}

/** Replies `text` to the post `target` names, in the reply box under it. */
export async function postXReply(page: PageSession, target: string, text: string): Promise<{ link: string | null }> {
  await open(page, `${ORIGIN}/i/status/${target}`);
  return { link: linkOf(await compose(page, 'x', { box: BOX, send: '[data-testid="tweetButtonInline"]', request: SENDS }, text)) };
}

/** Posts `post.text` from the compose page. */
export async function postX(page: PageSession, post: NewPost): Promise<{ link: string | null }> {
  await open(page, `${ORIGIN}/compose/post`);
  return { link: linkOf(await compose(page, 'x', { box: BOX, send: '[data-testid="tweetButton"]', request: SENDS }, post.text)) };
}

export const X: Adapter = {
  id: 'x',
  loginUrl: `${ORIGIN}/i/flow/login`,
  session: { domain: '.x.com', cookies: ['auth_token'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    const url = req.source === 'feed' ? `${ORIGIN}/home`
      : req.source === 'search' ? `${ORIGIN}/search?q=${encodeURIComponent(req.query.trim())}&src=typed_query${req.sort === 'latest' ? '&f=live' : ''}`
      : `${ORIGIN}/${encodeURIComponent(accountName(req.query))}`;
    await open(page, url);
    await scrollCollect(page, collector, { reader: readXPosts, ready: READY, adjust: withLargerImages });
    checkLogin(page.url());
  },

  owns: (url) => hostIs(url, 'x.com', 'twitter.com'),

  write: {
    replyTarget: xReplyTarget,
    comment: postXReply,
    commentMax: X_TEXT_MAX,
    length: xLength,
    posts: { needs: [], max: X_TEXT_MAX, publish: postX },
  },

  async read(page, url, maxComments) {
    const u = new URL(url);
    await open(page, `${ORIGIN}${u.pathname}`);
    await page.waitFor(READY, 10_000);
    const [first, ...rest] = await page.run(readXPosts, DOM_READ_DEFAULTS);
    if (!first) return null;
    const post = withLargerImages(domToPost('x', first, 'adapter'));
    const replies = rest.slice(0, Math.max(0, await page.run(threadLength, undefined) - 1));
    const comments = replies.filter((r) => !r.ad).slice(0, maxComments).map((r) => ({ author: r.author || undefined, text: r.text }));
    return { post, comments };
  },
};
