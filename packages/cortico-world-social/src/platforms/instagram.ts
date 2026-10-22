/**
 * Instagram: a profile's posts, a hashtag and a keyword search through the web JSON the site's own
 * pages use (it needs the site's app id header and a login), the home feed and single posts from
 * the pages. When the JSON is refused, the posts linked from the profile or search page are opened
 * one by one.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, scrollCollect, type Collector } from '../collect.ts';
import type { Post } from '../posts.ts';
import { readInstagramPosts, scrollDown } from './dom.ts';
import { accountName, hostIs, type Adapter } from './adapter.ts';
import { parseInstagramPosts } from './instagram-parse.ts';

const ORIGIN = 'https://www.instagram.com';
/** The id Instagram's web app sends with its own JSON requests. */
const WEB_APP_ID = '936619743392459';

async function open(page: PageSession, url: string): Promise<void> {
  const at = new URL(await page.goto(url));
  if (at.pathname.startsWith('/accounts/login')) throw new PlatformBlocked('instagram', 'login');
  if (at.pathname.startsWith('/challenge')) throw new PlatformBlocked('instagram', 'captcha');
}

/** A payload of the web JSON, or null when Instagram answered with something else. */
async function webJson(page: PageSession, path: string): Promise<unknown | null> {
  const rep = await page.fetchText(`${ORIGIN}${path}`, { headers: { 'x-ig-app-id': WEB_APP_ID, 'x-requested-with': 'XMLHttpRequest' } });
  if (rep.status === 401 || /"require_login"\s*:\s*true|"login_required"/.test(rep.text)) throw new PlatformBlocked('instagram', 'login');
  if (rep.status >= 400) return null;
  try {
    return JSON.parse(rep.text);
  } catch {
    return null;
  }
}

/** One post page: its caption, author, time and images. */
function readPostPage(): { author: string; text: string; time: string; images: Array<{ url: string; alt: string }>; video: boolean } | null {
  const meta = (p: string) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') ?? '';
  const caption = (document.querySelector('article h1, main h1') as HTMLElement | null)?.innerText.trim() ?? '';
  const og = meta('og:description');
  const text = caption || og.replace(/^[^:]*:\s*"?/, '').replace(/"\s*$/, '');
  // the post's own media: its article, else what comes before the grid of the author's other posts
  const article = document.querySelector('article');
  const more = article ? null : Array.from(document.querySelectorAll('main h2, main span')).find((e) => /^(More posts from|更多来自)/.test((e.textContent ?? '').trim())) ?? null;
  const images = Array.from((article ?? document).querySelectorAll(article ? 'img' : 'main img'))
    .map((i) => i as HTMLImageElement)
    .filter((i) => !more || (more.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING) !== 0)
    .filter((i) => (i.width || i.naturalWidth || 0) >= 150 && !/profile picture|头像/i.test(i.alt))
    .map((i) => ({ url: i.currentSrc || i.src, alt: i.alt }));
  if (!text && !images.length) return null;
  // the header's first link is the profile picture; the first with text is the name
  const author = Array.from(document.querySelectorAll('article header a[href^="/"], main header a[href^="/"]')).map((a) => (a as HTMLElement).innerText.trim()).find(Boolean)
    ?? meta('og:title').split(' ')[0] ?? '';
  return {
    author,
    text,
    time: document.querySelector('time[datetime]')?.getAttribute('datetime') ?? '',
    images: images.length ? images : meta('og:image') ? [{ url: meta('og:image'), alt: '' }] : [],
    video: !!document.querySelector('article video, main video') || meta('og:type') === 'video',
  };
}

const postLinks = () => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).map((a) => (a as HTMLAnchorElement).href.split('?')[0])));

async function readPost(page: PageSession, url: string): Promise<Post | null> {
  await open(page, url);
  await page.waitFor('article, main', 8000);
  const p = await page.run(readPostPage, undefined);
  if (!p) return null;
  const code = url.match(/\/(?:p|reel)\/([\w-]+)/)?.[1] ?? url;
  return {
    platform: 'instagram', id: code, url, author: p.author || undefined, text: p.text,
    publishedAt: p.time || undefined, stats: [],
    images: p.images.map((i) => (i.alt ? i : { url: i.url })),
    video: p.video || url.includes('/reel/'), extraction: 'adapter',
  };
}

/** Scrolls taken on a listing page to gather the links of more posts. */
const LINK_SCROLLS = 6;

/**
 * Opens the posts a listing page links to, one by one; reels are offered as video posts unopened.
 * The links are gathered first, scrolling for more, since opening a post leaves the listing.
 */
async function openLinked(page: PageSession, url: string, collector: Collector): Promise<void> {
  await open(page, url);
  await page.waitFor('a[href*="/p/"], a[href*="/reel/"]', Math.min(10_000, collector.deadline.leftMs));
  let links = await page.run(postLinks, undefined);
  for (let i = 0; i < LINK_SCROLLS && links.length < collector.want * 2 && !collector.deadline.up; i++) {
    if (!await page.run(scrollDown, undefined)) break;
    await page.pause(1200);
    const more = await page.run(postLinks, undefined);
    if (more.length === links.length) break;
    links = more;
  }
  for (const link of links) {
    if (collector.done) return;
    if (collector.offeredBefore(link.match(/\/(?:p|reel)\/([\w-]+)/)?.[1] ?? link, link)) continue;
    if (link.includes('/reel/')) {
      collector.offer({ platform: 'instagram', id: link, url: link, text: '', stats: [], images: [], video: true, extraction: 'adapter' });
      continue;
    }
    const post = await readPost(page, link);
    if (post && !collector.offer(post)) return;
  }
}

export const INSTAGRAM: Adapter = {
  id: 'instagram',
  loginUrl: `${ORIGIN}/accounts/login/`,
  session: { domain: '.instagram.com', cookies: ['sessionid'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    if (req.source === 'feed') {
      await open(page, `${ORIGIN}/`);
      await scrollCollect(page, collector, { reader: readInstagramPosts, ready: 'article' });
      return;
    }
    await open(page, `${ORIGIN}/`);
    const q = req.query.trim();
    const user = accountName(q);
    const path = req.source === 'account' ? `/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`
      : q.startsWith('#') ? `/api/v1/tags/web_info/?tag_name=${encodeURIComponent(q.slice(1))}`
      : `/api/v1/fbsearch/web/top_serp/?query=${encodeURIComponent(q)}`;
    const json = await webJson(page, path);
    const posts = json ? parseInstagramPosts(json) : [];
    for (const p of posts) if (!collector.offer(p)) return;
    // the JSON holds the first page only; the listing page gives the rest, and posts already offered are not offered twice
    const listing = req.source === 'account' ? `${ORIGIN}/${encodeURIComponent(user)}/`
      : q.startsWith('#') ? `${ORIGIN}/explore/tags/${encodeURIComponent(q.slice(1))}/`
      : `${ORIGIN}/explore/search/keyword/?q=${encodeURIComponent(q)}`;
    await openLinked(page, listing, collector);
  },

  owns: (url) => hostIs(url, 'instagram.com'),

  async read(page, url) {
    const post = await readPost(page, url.split('?')[0]);
    return post ? { post, comments: [] } : null;
  },
};
