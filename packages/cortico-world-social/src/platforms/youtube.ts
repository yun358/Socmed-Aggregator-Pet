/**
 * YouTube from its own pages: search results, a channel's videos and the home recommendations from
 * the page data, more results from the continuations the page fetches as it scrolls, and
 * transcripts from the captions the watch page's player loads. YouTube serves captions only with a
 * token its player makes, so the player is asked to load them and its request is read; a direct
 * fetch of the caption track and the transcript panel are the fallbacks.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, type Collector } from '../collect.ts';
import type { Post } from '../posts.ts';
import { accountName, hostIs, type Adapter, type TranscriptResult } from './adapter.ts';
import {
  YOUTUBE_ORIGIN, parseCaptionTracks, parseCaptionXml, parseJson3, parseTranscriptPanel, parseVideoDetails,
  parseYoutubeChannel, parseYoutubeFeed, parseYoutubeVideos, pickCaptionTrack, youtubeVideoId,
} from './youtube-parse.ts';

/** `sp` values for videos only: by relevance, by popularity (views), or uploaded within a period. */
const VIDEOS = 'EgIQAQ%3D%3D';
const POPULAR = 'CAMSAhAB';
/** The upload-date filters YouTube offers; it has none for the last hour since January 2026. */
const UPLOADED: Record<string, string> = { day: 'EgQIAhAB', week: 'EgQIAxAB', month: 'EgQIBBAB', year: 'EgQIBRAB' };
const CHANNEL_FILTER = 'EgIQAg%3D%3D';

/** A search's period filter when it names one YouTube has, else its popularity order when asked for. */
function searchOrder(sort?: string, period?: string): { sort?: string; period?: string; sp: string } {
  if (period && UPLOADED[period]) return { period, sp: UPLOADED[period] };
  if (sort === 'popularity' || sort === 'views') return { sort: 'popularity', sp: POPULAR };
  return { sp: VIDEOS };
}
const MORE_ROUNDS = 8;
const CAPTION_WAIT_MS = 15_000;

const pageData = () => (window as unknown as { ytInitialData?: unknown }).ytInitialData ?? null;
const playerData = () => (window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse ?? null;
const toBottom = () => { window.scrollTo(0, document.documentElement.scrollHeight); };
const hasPlayer = () => !!document.getElementById('movie_player');
/** The page data or a continuation ends with a token for loading more. */
const hasMore = (data: unknown): boolean => JSON.stringify(data ?? null).includes('continuationItemRenderer');

/** Asks the watch page's player to show the track in `code`, which makes it fetch the captions. */
function showCaptions(code: string): boolean {
  const player = document.getElementById('movie_player') as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined> | null;
  if (!player) return false;
  try { player.mute?.(); } catch { /* not ready */ }
  try { player.loadModule?.('captions'); } catch { /* not ready */ }
  try { player.setOption?.('captions', 'track', { languageCode: code }); } catch { /* not ready */ }
  try { player.playVideo?.(); } catch { /* not ready */ }
  return true;
}

/** Opens the transcript panel from the description; returns whether its button was found. */
function openTranscriptPanel(): boolean {
  (document.querySelector('#description-inline-expander #expand, tp-yt-paper-button#expand') as HTMLElement | null)?.click();
  const button = (document.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label="Show transcript"]')
    ?? Array.from(document.querySelectorAll('button')).find((b) => /transcript|文字记录|字幕/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))) as HTMLElement | undefined;
  button?.click();
  return !!button;
}

/** Segments of either transcript panel layout, the older renderer or the newer view model. */
const SEGMENTS = 'ytd-transcript-segment-renderer, transcript-segment-view-model';

/** The transcript panel's segments as the page shows them. */
function readTranscriptPanel(): Array<{ startSec: number; text: string }> {
  return Array.from(document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')).map((s) => {
    const stamp = (s.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp') as HTMLElement | null)?.innerText.trim() ?? '0:00';
    const startSec = stamp.split(':').reduce((acc, part) => acc * 60 + Number(part || 0), 0);
    return { startSec, text: (s.querySelector('.segment-text, span[role="text"]') as HTMLElement | null)?.innerText.trim() ?? '' };
  }).filter((l) => l.text);
}

function checkPage(url: string): void {
  const host = new URL(url).hostname;
  if (/^consent\./.test(host)) throw new PlatformBlocked('youtube', 'consent');
  if (host.endsWith('accounts.google.com')) throw new PlatformBlocked('youtube', 'login');
}

async function open(page: PageSession, url: string): Promise<void> {
  checkPage(await page.goto(url));
  await page.waitFor('script', 5000);
}

/** Offers the page's videos, then those of the continuations the page loads while it scrolls. */
async function offerAll(page: PageSession, collector: Collector, author?: string): Promise<void> {
  const offer = (videos: Post[]) => {
    for (const v of videos) {
      if (author && !v.author) v.author = author;
      if (!collector.offer(v)) return false;
    }
    return true;
  };
  let data = await page.run(pageData, undefined);
  if (!offer(parseYoutubeVideos(data))) return;
  for (let i = 0; i < MORE_ROUNDS && !collector.done && hasMore(data); i++) {
    const more = await page.captureResponse(/\/youtubei\/v1\/(search|browse)\b/, () => page.run(toBottom, undefined), Math.min(6000, collector.deadline.leftMs));
    if (!more) return;
    try { data = JSON.parse(more.text); } catch { return; }
    const videos = parseYoutubeVideos(data);
    if (!videos.length || !offer(videos)) return;
  }
}

/** The channel URL for an account query: a channel URL or id as given, else the handle, else the first channel a search finds. */
async function channelUrl(page: PageSession, query: string): Promise<string | null> {
  const q = query.trim();
  const id = q.match(/\b(UC[\w-]{22})\b/)?.[1];
  if (id) return `${YOUTUBE_ORIGIN}/channel/${id}`;
  try {
    const u = new URL(q);
    if (hostIs(u, 'youtube.com')) return `${YOUTUBE_ORIGIN}${u.pathname.replace(/\/(videos|featured|shorts|streams)\/?$/, '')}`;
  } catch { /* a name or handle */ }
  const handle = accountName(q).replace(/\s+/g, '');
  if (handle) {
    await open(page, `${YOUTUBE_ORIGIN}/@${encodeURIComponent(handle)}`);
    if (parseYoutubeChannel(await page.run(pageData, undefined))) return `${YOUTUBE_ORIGIN}/@${encodeURIComponent(handle)}`;
  }
  await open(page, `${YOUTUBE_ORIGIN}/results?search_query=${encodeURIComponent(q)}&sp=${CHANNEL_FILTER}`);
  const data = JSON.stringify(await page.run(pageData, undefined) ?? {});
  const base = data.match(/"canonicalBaseUrl":"(\/@[^"]+)"/)?.[1];
  if (base) return `${YOUTUBE_ORIGIN}${base}`;
  const found = data.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
  return found ? `${YOUTUBE_ORIGIN}/channel/${found}` : null;
}

async function transcript(page: PageSession, ref: string): Promise<TranscriptResult> {
  const id = youtubeVideoId(ref);
  const url = id ? `${YOUTUBE_ORIGIN}/watch?v=${id}` : ref;
  if (!id) return { kind: 'none', reason: 'unavailable', url };
  await open(page, url);
  const player = await page.run(playerData, undefined) as { playabilityStatus?: { status?: string; reason?: string } } | null;
  const status = player?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED') throw new PlatformBlocked('youtube', 'login', player?.playabilityStatus?.reason ?? '');
  const details = parseVideoDetails(player);
  const track = pickCaptionTrack(parseCaptionTracks(player));
  if (!track) return { kind: 'none', reason: status && status !== 'OK' ? 'unavailable' : 'no-captions', title: details.title, url };
  const done = (lines: ReturnType<typeof parseJson3>): TranscriptResult => ({
    kind: 'ok',
    transcript: { platform: 'youtube', id, url, ...details, language: track.name || track.languageCode, generated: track.kind === 'asr', lines },
  });
  const parse = (text: string) => (text.trimStart().startsWith('{') ? parseJson3(JSON.parse(text)) : parseCaptionXml(text));
  // the player's own request carries the token YouTube asks for
  if (await page.run(hasPlayer, undefined)) {
    const shown = await page.captureResponse(new RegExp(`/api/timedtext\\?.*\\bv=${id}\\b`), () => page.run(showCaptions, track.languageCode), CAPTION_WAIT_MS);
    if (shown && shown.status < 400 && shown.text.trim()) {
      const lines = parse(shown.text);
      if (lines.length) return done(lines);
    }
  }
  const direct = await page.fetchText(`${track.baseUrl}&fmt=json3`);
  if (direct.status < 400 && direct.text.trim()) {
    const lines = parse(direct.text);
    if (lines.length) return done(lines);
  }
  const panel = await page.captureResponse(/\/youtubei\/v1\/(get_transcript|get_panel)\b/, () => page.run(openTranscriptPanel, undefined), CAPTION_WAIT_MS);
  let lines: ReturnType<typeof parseJson3> = [];
  try { lines = panel && panel.status < 400 ? parseTranscriptPanel(JSON.parse(panel.text)) : []; } catch { /* the panel's own layout is read below */ }
  if (!lines.length && await page.waitFor(SEGMENTS, 5000)) lines = await page.run(readTranscriptPanel, undefined);
  return lines.length ? done(lines) : { kind: 'none', reason: 'unavailable', title: details.title, url };
}

export const YOUTUBE: Adapter = {
  id: 'youtube',
  loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
  session: { domain: '.youtube.com', cookies: ['SID', '__Secure-3PSID', 'LOGIN_INFO'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    if (req.source === 'search') {
      const { sp } = searchOrder(req.sort, req.period);
      await open(page, `${YOUTUBE_ORIGIN}/results?search_query=${encodeURIComponent(req.query.trim())}&sp=${sp}`);
      await offerAll(page, collector);
      return;
    }
    if (req.source === 'feed') {
      await open(page, `${YOUTUBE_ORIGIN}/`);
      const before = collector.posts.length;
      await offerAll(page, collector);
      // without a login and watch history the home page asks to search instead of listing videos
      if (collector.posts.length === before && JSON.stringify(await page.run(pageData, undefined) ?? null).includes('feedNudgeRenderer')) {
        throw new PlatformBlocked('youtube', 'login', 'YouTube lists no home feed without a login and watch history');
      }
      return;
    }
    const channel = await channelUrl(page, req.query);
    if (!channel) return;
    await open(page, `${channel}/videos`);
    const meta = parseYoutubeChannel(await page.run(pageData, undefined));
    const before = collector.posts.length;
    await offerAll(page, collector, meta?.name);
    if (collector.posts.length > before || !meta) return;
    // the videos tab in a layout the reader does not know: the channel's feed lists its newest
    const feed = await page.fetchText(`${YOUTUBE_ORIGIN}/feeds/videos.xml?channel_id=${meta.id}`);
    if (feed.status < 400) for (const v of parseYoutubeFeed(feed.text)) if (!collector.offer(v)) return;
  },

  applied: (req) => {
    if (req.source !== 'search') return {};
    const { sort, period } = searchOrder(req.sort, req.period);
    return { sort, period };
  },

  owns: (url) => hostIs(url, 'youtube.com', 'youtu.be'),

  async read(page, url) {
    const id = youtubeVideoId(url);
    if (!id) return null;
    await open(page, `${YOUTUBE_ORIGIN}/watch?v=${id}`);
    const player = await page.run(playerData, undefined) as {
      videoDetails?: { shortDescription?: string; viewCount?: string };
      microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
      playabilityStatus?: { status?: string; reason?: string };
    } | null;
    if (player?.playabilityStatus?.status === 'LOGIN_REQUIRED') throw new PlatformBlocked('youtube', 'login', player.playabilityStatus.reason ?? '');
    if (!player?.videoDetails) return null;
    const details = parseVideoDetails(player);
    const views = player.videoDetails.viewCount;
    return {
      post: {
        platform: 'youtube', id, url: `${YOUTUBE_ORIGIN}/watch?v=${id}`,
        author: details.author, title: details.title, text: player.videoDetails.shortDescription ?? '',
        publishedAt: player.microformat?.playerMicroformatRenderer?.publishDate,
        stats: views ? [['views', views]] : [], images: [], video: true, duration: details.duration, extraction: 'adapter',
      },
      comments: [],
    };
  },

  transcript: (page, ref) => transcript(page, ref),
};
