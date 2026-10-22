/** X (Twitter) from its pages: the home timeline, search, a profile, and a post with its replies. */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, domToPost, scrollCollect } from '../collect.ts';
import type { Post } from '../posts.ts';
import { DOM_READ_DEFAULTS, readXPosts } from './dom.ts';
import { accountName, hostIs, type Adapter } from './adapter.ts';

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
