/**
 * Facebook from its pages: the news feed, post search, a page or profile, a group, and one post.
 * "See more" is expanded before each read so the whole text is read.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, domToPost, scrollCollect } from '../collect.ts';
import { DOM_READ_DEFAULTS, expandFacebookPosts, readFacebookPosts, readPageText } from './dom.ts';
import { accountName, hostIs, type Adapter } from './adapter.ts';

const ORIGIN = 'https://www.facebook.com';
const READY = '[role="feed"], [role="article"], [aria-posinset]';

const loginForm = () => !!document.querySelector('form#login_form, form[action*="/login"] input[name="pass"]');

async function open(page: PageSession, url: string): Promise<void> {
  const at = new URL(await page.goto(url));
  if (at.pathname.startsWith('/login') || at.pathname.startsWith('/checkpoint')) throw new PlatformBlocked('facebook', at.pathname.startsWith('/checkpoint') ? 'captcha' : 'login');
  if (await page.run(loginForm, undefined)) throw new PlatformBlocked('facebook', 'login');
}

/**
 * A page or profile named by link, numeric id or handle. A link keeps its query, which holds the id of
 * a `profile.php?id=` profile; a bare `profile.php` would open the person's own profile.
 */
function accountUrl(query: string): string {
  const q = query.trim();
  if (/^\d+$/.test(q)) return `${ORIGIN}/profile.php?id=${q}`;
  try {
    const u = new URL(q);
    if (hostIs(u, 'facebook.com', 'fb.com')) return `${ORIGIN}${u.pathname}${u.search}`;
  } catch { /* a handle */ }
  return `${ORIGIN}/${encodeURIComponent(accountName(q))}`;
}

/** A group named by id, URL or path; the group's own URL otherwise. */
function groupUrl(query: string): string {
  const q = query.trim();
  try {
    const u = new URL(q);
    return `${ORIGIN}${u.pathname}`;
  } catch {
    return `${ORIGIN}/groups/${encodeURIComponent(q.replace(/^\/?groups\//, ''))}`;
  }
}

export const FACEBOOK: Adapter = {
  id: 'facebook',
  loginUrl: `${ORIGIN}/login/`,
  session: { domain: '.facebook.com', cookies: ['c_user'] },
  sources: ['feed', 'search', 'account', 'community'],

  async list(page, req, collector) {
    const url = req.source === 'feed' ? `${ORIGIN}/`
      : req.source === 'search' ? `${ORIGIN}/search/posts/?q=${encodeURIComponent(req.query.trim())}`
      : req.source === 'community' ? groupUrl(req.query)
      : accountUrl(req.query);
    await open(page, url);
    await scrollCollect(page, collector, {
      reader: readFacebookPosts,
      ready: READY,
      beforeRead: async () => {
        if (await page.run(expandFacebookPosts, undefined)) await page.pause(400);
      },
    });
  },

  owns: (url) => hostIs(url, 'facebook.com', 'fb.com', 'fb.watch'),

  async read(page, url) {
    await open(page, url);
    await page.waitFor(READY, 10_000);
    if (await page.run(expandFacebookPosts, undefined)) await page.pause(400);
    const [first] = await page.run(readFacebookPosts, DOM_READ_DEFAULTS);
    if (first) return { post: domToPost('facebook', { ...first, url: first.url || url }, 'adapter'), comments: [] };
    const text = await page.run(readPageText, 6000);
    if (!text.text) return null;
    return { post: { platform: 'facebook', id: url, url, title: text.title, text: text.text, stats: [], images: [], video: false, extraction: 'generic' }, comments: [] };
  },
};
