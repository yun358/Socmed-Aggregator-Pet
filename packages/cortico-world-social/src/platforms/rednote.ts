/**
 * Rednote (Xiaohongshu) from its pages: explore, search and a profile list note cards; each note's
 * full text and images are on its own page, which needs the card's `xsec_token`. Notes are opened
 * with a pause between them, since Rednote sends fast visitors to a captcha. Search needs a login.
 * Rednote sets its session cookie for guests too, so a login is read from the page.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, scrollCollect, type Collector } from '../collect.ts';
import type { Post } from '../posts.ts';
import { readRednoteCards, readRednoteNote, rednoteBlocked, scrollDown, type RednoteCard } from './dom.ts';
import { hostIs, type Adapter } from './adapter.ts';

const ORIGIN = 'https://www.xiaohongshu.com';
/** Pause between note pages. */
const NOTE_PAUSE_MS = 2500;
const SCROLLS_MAX = 6;

async function open(page: PageSession, url: string): Promise<void> {
  await page.goto(url);
  const blocked = await page.run(rednoteBlocked, undefined);
  if (blocked) throw new PlatformBlocked('rednote', blocked.kind, blocked.detail);
}

/** Where a card was listed, as Rednote names it in a note link's `xsec_source`. */
type CardSource = 'pc_feed' | 'pc_search' | 'pc_user';

const noteUrl = (card: Pick<RednoteCard, 'id' | 'xsecToken'>, source: CardSource | string = 'pc_feed') =>
  `${ORIGIN}/explore/${card.id}${card.xsecToken ? `?xsec_token=${encodeURIComponent(card.xsecToken)}&xsec_source=${source}` : ''}`;

/** A profile is named by its URL, whose `xsec_token` and `xsec_source` it keeps, or its 24-character id. */
function profileUrl(query: string): string | null {
  const id = query.match(/\b([0-9a-f]{24})\b/)?.[1];
  if (!id) return null;
  let keep = '';
  try {
    const q = new URL(query.trim()).searchParams;
    const params = new URLSearchParams();
    for (const k of ['xsec_token', 'xsec_source']) if (q.get(k)) params.set(k, q.get(k)!);
    keep = params.size ? `?${params}` : '';
  } catch { /* an id */ }
  return `${ORIGIN}/user/profile/${id}${keep}`;
}

/** Whether the page shows the logged-in person's own sidebar link (我 / Me), or the state says so. */
function rednoteLoggedIn(): boolean {
  const state = (window as unknown as { __INITIAL_STATE__?: { user?: Record<string, unknown> } }).__INITIAL_STATE__;
  const flag = state?.user?.loggedIn as unknown;
  const value = flag && typeof flag === 'object' ? (flag as Record<string, unknown>)._rawValue ?? (flag as Record<string, unknown>)._value ?? (flag as Record<string, unknown>).value : flag;
  if (value === true) return true;
  return Array.from(document.querySelectorAll('a[href*="/user/profile/"]')).some((a) => /^(我|Me)$/.test(((a as HTMLElement).innerText ?? '').trim()));
}

/** Rednote's login dialog over a page it shows only to logged-in visitors. */
const loginWall = () => !!document.querySelector('.login-container, .login-modal, [class*="login-container"]');

/** The note page's own message when the note cannot be viewed (deleted, private, or a link without its token). */
const unavailable = () => ((document.querySelector('.access-wrapper, .error-wrapper, .not-found-wrapper') as HTMLElement | null)?.innerText ?? '').trim();

async function readNote(page: PageSession, card: Pick<RednoteCard, 'id' | 'xsecToken'>, source?: string): Promise<Post | null> {
  const url = noteUrl(card, source);
  await open(page, url);
  await page.waitFor('#detail-desc, .note-content, #noteContainer, .access-wrapper, .error-wrapper, .not-found-wrapper', 8000);
  const gone = await page.run(unavailable, undefined);
  if (gone) throw new PlatformBlocked('rednote', 'blocked', gone);
  const n = await page.run(readRednoteNote, card.id);
  if (!n) return null;
  const tags = n.tags.length ? `\n${n.tags.map((t) => `#${t}`).join(' ')}` : '';
  return {
    platform: 'rednote', id: card.id, url, author: n.author || undefined, title: n.title || undefined,
    text: n.text + tags, publishedAt: n.time || undefined, stats: n.stats,
    images: n.images.map((u) => ({ url: u })), video: n.video, extraction: 'adapter',
  };
}

/** Cards from the listing, scrolling for more, then each note opened until the collector is done. */
async function fromCards(page: PageSession, collector: Collector, source: CardSource): Promise<boolean> {
  await page.waitFor('section.note-item', Math.min(10_000, collector.deadline.leftMs));
  const cards: RednoteCard[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= SCROLLS_MAX && cards.length < collector.want * 2; i++) {
    for (const c of await page.run(readRednoteCards, undefined)) if (!seen.has(c.id)) { seen.add(c.id); cards.push(c); }
    if (!await page.run(scrollDown, undefined)) break;
    await page.pause(1200);
  }
  if (!cards.length) return false;
  for (const card of cards) {
    if (collector.done) break;
    // a video note or, in text-only mode, any note (every note leads with an image) is decided from its card
    if (card.video || collector.images === 'skip') {
      collector.offer({ platform: 'rednote', id: card.id, url: noteUrl(card, source), title: card.title, text: '', stats: [], images: card.cover ? [{ url: card.cover }] : [], video: card.video, extraction: 'adapter' });
      continue;
    }
    const post = await readNote(page, card, source);
    if (post && !collector.offer(post)) break;
    await page.pause(Math.min(NOTE_PAUSE_MS, collector.deadline.leftMs));
  }
  return true;
}

export const REDNOTE: Adapter = {
  id: 'rednote',
  loginUrl: `${ORIGIN}/explore`,
  session: { domain: '.xiaohongshu.com', cookies: ['web_session'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    const url = req.source === 'feed' ? `${ORIGIN}/explore`
      : req.source === 'search' ? `${ORIGIN}/search_result?keyword=${encodeURIComponent(req.query.trim())}&source=web_search_result_notes&type=51`
      : profileUrl(req.query);
    if (!url) return;
    await open(page, url);
    const source: CardSource = req.source === 'search' ? 'pc_search' : req.source === 'account' ? 'pc_user' : 'pc_feed';
    if (await fromCards(page, collector, source)) return;
    if (await page.run(loginWall, undefined)) throw new PlatformBlocked('rednote', 'login');
    await scrollCollect(page, collector, { reader: null });
  },

  owns: (url) => hostIs(url, 'xiaohongshu.com', 'xhslink.com', 'rednote.com'),

  // the app shares xhslink.com links, which redirect to the note
  shareLink: (url) => hostIs(url, 'xhslink.com'),

  async loggedIn(page) {
    await open(page, `${ORIGIN}/explore`);
    await page.waitFor('a[href*="/user/profile/"]', 5000);
    return page.run(rednoteLoggedIn, undefined);
  },

  async read(page, url) {
    const u = new URL(url);
    const id = u.pathname.match(/([0-9a-f]{24})/)?.[1];
    if (!id) return null;
    const post = await readNote(page, { id, xsecToken: u.searchParams.get('xsec_token') ?? '' }, u.searchParams.get('xsec_source') ?? undefined);
    return post ? { post, comments: [] } : null;
  },
};
