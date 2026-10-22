/**
 * Bilibili through its web API, called from a bilibili.com page so requests carry the browser's
 * cookies: search, an uploader's videos, the home recommendations, a video's details and top
 * comments, and subtitles. The `wbi/` endpoints are signed (`wbiSign`); an uploader's list falls
 * back to the space page when its endpoint refuses. Bilibili shows its AI subtitles only to
 * logged-in viewers.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked } from '../collect.ts';
import { clean, type Comment, type Post } from '../posts.ts';
import { hostIs, type Adapter, type TranscriptResult } from './adapter.ts';
import {
  BILIBILI_API, BILIBILI_ORIGIN, bilibiliVideoId, parseBilibiliSubtitleBody, parseBilibiliSubtitles, parseBilibiliUser,
  parseBilibiliVideos, parseBilibiliView, wbiKeys, wbiSign,
} from './bilibili-parse.ts';

const SEARCH_ORDERS: Record<string, string> = { relevance: 'totalrank', date: 'pubdate', views: 'click' };
const PAGES_MAX = 5;
/** Pause between pages of a listing; Bilibili answers fast callers with -799. */
const PAGE_PAUSE_MS = 1000;

/** A refusal in Bilibili's answer: -101 is not logged in, -352 and -412 its risk control, any other non-zero code as it says. */
function check(json: unknown): void {
  const { code, message } = (json ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code !== 'number' || code === 0) return;
  if (code === -101) throw new PlatformBlocked('bilibili', 'login');
  if (code === -352 || code === -412) throw new PlatformBlocked('bilibili', 'captcha', `code ${code}`);
  throw new PlatformBlocked('bilibili', 'blocked', `code ${code}${typeof message === 'string' && message ? ` ${message}` : ''}`);
}

async function onBilibili(page: PageSession): Promise<void> {
  if (!page.url().startsWith(BILIBILI_ORIGIN)) await page.goto(`${BILIBILI_ORIGIN}/`);
}

async function api(page: PageSession, path: string): Promise<unknown> {
  const rep = await page.fetchText(`${BILIBILI_API}${path}`);
  if (rep.status === 412) throw new PlatformBlocked('bilibili', 'captcha', 'HTTP 412');
  if (rep.status >= 400) throw new PlatformBlocked('bilibili', 'blocked', `HTTP ${rep.status}`);
  try {
    return JSON.parse(rep.text);
  } catch {
    throw new PlatformBlocked('bilibili', 'blocked', 'the answer was not JSON');
  }
}

/** The signing keys each page has read, so the pages of one listing read them once. */
const wbi = new WeakMap<PageSession, { imgKey: string; subKey: string }>();

/** A signed `wbi/` call; the keys come from `nav`, which answers logged in or not. */
async function signed(page: PageSession, path: string, params: Record<string, string | number>): Promise<unknown> {
  let keys = wbi.get(page);
  if (!keys) {
    keys = wbiKeys(await api(page, '/x/web-interface/nav')) ?? undefined;
    if (!keys) throw new PlatformBlocked('bilibili', 'blocked', 'no signing keys');
    wbi.set(page, keys);
  }
  const json = await api(page, `${path}?${wbiSign(params, keys, Math.floor(Date.now() / 1000))}`);
  check(json);
  return json;
}

/**
 * Video links on a page Bilibili draws itself (an uploader's space page), each video once with its
 * title: a link's `title` attribute, else the longest link text that is not the cover's counts and
 * length.
 */
function readVideoLinks(): Array<{ bvid: string; title: string }> {
  const titles = new Map<string, string>();
  const fromAttr = new Set<string>();
  const stats = /^[\d.,:\s·万亿]*$/;
  for (const a of Array.from(document.querySelectorAll('a[href*="/video/BV"]'))) {
    const bvid = ((a as HTMLAnchorElement).href.match(/\/video\/(BV[0-9A-Za-z]{10})/) ?? [])[1];
    if (!bvid || fromAttr.has(bvid)) continue;
    const attr = (a.getAttribute('title') ?? '').trim();
    const text = ((a as HTMLElement).innerText ?? '').trim();
    if (attr) { titles.set(bvid, attr); fromAttr.add(bvid); }
    else if (!stats.test(text) && text.length > (titles.get(bvid) ?? '').length) titles.set(bvid, text);
    else if (!titles.has(bvid)) titles.set(bvid, '');
  }
  return Array.from(titles, ([bvid, title]) => ({ bvid, title })).filter((v) => v.title);
}

async function uploaderId(page: PageSession, query: string): Promise<number | null> {
  const q = query.trim();
  const fromUrl = q.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? (/^\d+$/.test(q) ? q : null);
  if (fromUrl) return Number(fromUrl);
  const found = parseBilibiliUser(await signed(page, '/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: q }));
  return found?.mid ?? null;
}

async function transcript(page: PageSession, ref: string): Promise<TranscriptResult> {
  const bvid = bilibiliVideoId(ref);
  const url = bvid ? `${BILIBILI_ORIGIN}/video/${bvid}` : ref;
  if (!bvid) return { kind: 'none', reason: 'unavailable', url };
  await onBilibili(page);
  const viewJson = await api(page, `/x/web-interface/view?bvid=${bvid}`);
  check(viewJson);
  const view = parseBilibiliView(viewJson);
  if (!view) return { kind: 'none', reason: 'unavailable', url };
  const { tracks, needLogin } = parseBilibiliSubtitles(await signed(page, '/x/player/wbi/v2', { bvid, cid: view.cid }));
  const track = tracks.find((t) => !t.generated) ?? tracks[0];
  if (!track) return { kind: 'none', reason: needLogin ? 'login' : 'no-captions', title: view.title, url };
  const raw = await page.fetchRaw(track.url, `${BILIBILI_ORIGIN}/`, 'application/json');
  let lines: ReturnType<typeof parseBilibiliSubtitleBody> = [];
  try { lines = raw ? parseBilibiliSubtitleBody(JSON.parse(new TextDecoder().decode(raw.bytes))) : []; } catch { lines = []; }
  if (!lines.length) return { kind: 'none', reason: 'unavailable', title: view.title, url };
  return {
    kind: 'ok',
    transcript: { platform: 'bilibili', id: bvid, url, title: view.title, author: view.author, duration: view.duration, language: track.language, generated: track.generated, lines },
  };
}

export const BILIBILI: Adapter = {
  id: 'bilibili',
  loginUrl: 'https://passport.bilibili.com/login',
  session: { domain: '.bilibili.com', cookies: ['SESSDATA'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    await onBilibili(page);
    const offer = (videos: Post[]) => { for (const v of videos) if (!collector.offer(v)) return false; return videos.length > 0; };
    if (req.source === 'search') {
      for (let pn = 1; pn <= PAGES_MAX && !collector.done; pn++) {
        if (pn > 1) await page.pause(PAGE_PAUSE_MS);
        const json = await signed(page, '/x/web-interface/wbi/search/type', { search_type: 'video', keyword: req.query.trim(), page: pn, order: SEARCH_ORDERS[req.sort ?? ''] ?? 'totalrank' });
        if (!offer(parseBilibiliVideos(json))) return;
      }
      return;
    }
    if (req.source === 'feed') {
      for (let idx = 1; idx <= PAGES_MAX && !collector.done; idx++) {
        if (idx > 1) await page.pause(PAGE_PAUSE_MS);
        const json = await signed(page, '/x/web-interface/wbi/index/top/feed/rcmd', { ps: 20, fresh_idx: idx, fresh_type: 4, feed_version: 'V8' });
        if (!offer(parseBilibiliVideos(json))) return;
      }
      return;
    }
    const mid = await uploaderId(page, req.query);
    if (!mid) return;
    try {
      for (let pn = 1; pn <= PAGES_MAX && !collector.done; pn++) {
        if (pn > 1) await page.pause(PAGE_PAUSE_MS);
        const json = await signed(page, '/x/space/wbi/arc/search', { mid, ps: 30, pn, order: 'pubdate' });
        if (!offer(parseBilibiliVideos(json))) return;
      }
    } catch (err) {
      if (!(err instanceof PlatformBlocked) || err.kind === 'login') throw err;
      // the space page lists the same videos when the endpoint's risk control refuses
      await page.goto(`https://space.bilibili.com/${mid}/upload/video`);
      await page.waitFor('a[href*="/video/BV"]', Math.min(10_000, collector.deadline.leftMs));
      for (const v of await page.run(readVideoLinks, undefined)) {
        const post: Post = { platform: 'bilibili', id: v.bvid, url: `${BILIBILI_ORIGIN}/video/${v.bvid}`, title: v.title, text: '', stats: [], images: [], video: true, extraction: 'adapter' };
        if (!collector.offer(post)) return;
      }
    }
  },

  applied: (req) => (req.source === 'search' && req.sort && SEARCH_ORDERS[req.sort] ? { sort: req.sort } : {}),

  owns: (url) => hostIs(url, 'bilibili.com', 'b23.tv'),

  // the apps share b23.tv links, which redirect to the video
  shareLink: (url) => hostIs(url, 'b23.tv'),

  async read(page, url, maxComments) {
    const bvid = bilibiliVideoId(url);
    if (!bvid) return null;
    await onBilibili(page);
    const json = await api(page, `/x/web-interface/view?bvid=${bvid}`);
    check(json);
    const d = (json as { data?: { aid?: number; title?: string; desc?: string; owner?: { name?: string }; pubdate?: number; stat?: { view?: number; like?: number; reply?: number }; duration?: number } }).data;
    if (!d) return null;
    const [post] = parseBilibiliVideos({ data: { list: [{ ...d, bvid }] } });
    if (!post) return null;
    post.stats = [['views', String(d.stat?.view ?? '')], ['likes', String(d.stat?.like ?? '')], ['comments', String(d.stat?.reply ?? '')]].filter(([, v]) => v) as Post['stats'];
    const comments: Comment[] = [];
    if (d.aid && maxComments > 0) {
      const reply = await api(page, `/x/v2/reply?type=1&oid=${d.aid}&sort=1&ps=${Math.min(20, maxComments)}`) as { code?: number; data?: { replies?: Array<{ member?: { uname?: string }; content?: { message?: string }; like?: number }> } };
      // comments Bilibili refuses (a non-zero code) are left out; the video is still read
      for (const r of reply.code === 0 ? reply.data?.replies ?? [] : []) {
        if (comments.length >= maxComments) break;
        const text = clean(r.content?.message);
        if (text) comments.push({ author: r.member?.uname, text, ...(typeof r.like === 'number' ? { score: `${r.like} likes` } : {}) });
      }
    }
    return { post, comments };
  },

  transcript: (page, ref) => transcript(page, ref),
};
