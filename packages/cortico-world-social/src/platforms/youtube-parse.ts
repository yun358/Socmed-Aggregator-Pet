/**
 * YouTube's page data (`ytInitialData`), channel feeds and caption payloads read into posts and
 * transcripts. The page data is walked for every video renderer shape YouTube uses (the classic
 * `*VideoRenderer`s and the newer `lockupViewModel`), so a layout that moves them still parses.
 */
import { clean, type Post, type Transcript, type TranscriptLine } from '../posts.ts';

export const YOUTUBE_ORIGIN = 'https://www.youtube.com';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ simpleText }`, `{ runs: [{ text }] }` or `{ content }`, YouTube's three text shapes. */
export function ytText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (typeof v.content === 'string') return v.content;
  if (Array.isArray(v.runs)) return v.runs.map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : '')).join('');
  return '';
}

const DURATION = /^\d{1,2}(:\d{2}){1,2}$/;

function video(id: string, fields: { title: string; author?: string; published?: string; duration?: string; views?: string; snippet?: string; short?: boolean }): Post {
  // YouTube's counts carry their own word ("1.2M views"), so they take no label
  const stats: Post['stats'] = fields.views ? [['', fields.views]] : [];
  return {
    platform: 'youtube',
    id,
    url: fields.short ? `${YOUTUBE_ORIGIN}/shorts/${id}` : `${YOUTUBE_ORIGIN}/watch?v=${id}`,
    author: fields.author || undefined,
    title: clean(fields.title) + (fields.short ? ' (Short)' : ''),
    text: clean(fields.snippet),
    publishedText: fields.published || undefined,
    stats,
    images: [],
    video: true,
    duration: fields.duration || undefined,
    extraction: 'adapter',
  };
}

function fromRenderer(r: Json): Post | null {
  const id = typeof r.videoId === 'string' ? r.videoId : '';
  if (!id) return null;
  const snippet = Array.isArray(r.detailedMetadataSnippets) && isObj(r.detailedMetadataSnippets[0])
    ? ytText((r.detailedMetadataSnippets[0] as Json).snippetText)
    : ytText(r.descriptionSnippet);
  return video(id, {
    title: ytText(r.title) || ytText(r.headline),
    author: ytText(r.ownerText) || ytText(r.longBylineText) || ytText(r.shortBylineText),
    published: ytText(r.publishedTimeText),
    duration: ytText(r.lengthText),
    views: ytText(r.viewCountText) || ytText(r.shortViewCountText),
    snippet,
  });
}

/** Every `text` string under `v`, in document order. */
function texts(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) texts(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'text' || k === 'content') && typeof x === 'string') out.push(x);
      else texts(x, out);
    }
  }
  return out;
}

function fromLockup(l: Json): Post | null {
  const id = typeof l.contentId === 'string' ? l.contentId : '';
  const type = typeof l.contentType === 'string' ? l.contentType : '';
  if (!id || (type && !type.includes('VIDEO'))) return null;
  const meta = isObj(l.metadata) && isObj(l.metadata.lockupMetadataViewModel) ? l.metadata.lockupMetadataViewModel : {};
  const rows = isObj(meta.metadata) && isObj(meta.metadata.contentMetadataViewModel) && Array.isArray(meta.metadata.contentMetadataViewModel.metadataRows)
    ? (meta.metadata.contentMetadataViewModel.metadataRows as unknown[]).map((row) => texts(row).map((t) => t.trim()).filter((t) => t && t !== '•'))
    : [];
  const duration = texts(l.contentImage).map((t) => t.trim()).find((t) => DURATION.test(t));
  // rows: [channel], [views, age]; a search result may lead with a badge row
  const flat = rows.flat();
  const views = flat.find((t) => /\bviews?\b|次观看|播放/.test(t));
  const published = flat.find((t) => /\bago\b|前$|Streamed|Premiered/.test(t));
  const author = rows.find((row) => row.length === 1 && row[0] !== views && row[0] !== published)?.[0];
  return video(id, { title: ytText(meta.title), author, views, published, duration });
}

function fromShort(s: Json): Post | null {
  const id = typeof s.videoId === 'string' ? s.videoId
    : isObj(s.onTap) ? String((JSON.stringify(s.onTap).match(/"videoId":"([^"]+)"/) ?? [])[1] ?? '') : '';
  if (!id) return null;
  const title = ytText(s.headline) || (isObj(s.overlayMetadata) ? ytText(s.overlayMetadata.primaryText) : '');
  const views = ytText(s.viewCountText) || (isObj(s.overlayMetadata) ? ytText(s.overlayMetadata.secondaryText) : '');
  return video(id, { title, views, short: true });
}

const RENDERERS = new Set(['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'videoWithContextRenderer', 'playlistVideoRenderer']);
const SHORTS = new Set(['reelItemRenderer', 'shortsLockupViewModel']);

/** Every video `ytInitialData` lists, in page order, each once; ads are not walked into. */
export function parseYoutubeVideos(data: unknown): Post[] {
  const seen = new Set<string>();
  const out: Post[] = [];
  const add = (p: Post | null) => { if (p && p.title && !seen.has(p.id)) { seen.add(p.id); out.push(p); } };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'adSlotRenderer' || k === 'promotedSparklesWebRenderer' || k === 'promotedVideoRenderer') continue;
      if (!isObj(x)) { walk(x); continue; }
      if (RENDERERS.has(k)) add(fromRenderer(x));
      else if (k === 'lockupViewModel') add(fromLockup(x));
      else if (SHORTS.has(k)) add(fromShort(x));
      else walk(x);
    }
  };
  walk(data);
  return out;
}

/** The channel a channel page is about: its id (for the channel feed) and name. */
export function parseYoutubeChannel(data: unknown): { id: string; name: string } | null {
  const meta = isObj(data) && isObj(data.metadata) && isObj(data.metadata.channelMetadataRenderer) ? data.metadata.channelMetadataRenderer : null;
  const id = meta && typeof meta.externalId === 'string' ? meta.externalId : '';
  return id ? { id, name: typeof meta!.title === 'string' ? meta!.title : '' } : null;
}

const decodeXml = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const tag = (xml: string, name: string): string => decodeXml((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) ?? [])[1] ?? '').trim();

/** A channel's Atom feed (`/feeds/videos.xml?channel_id=`): its newest videos, newest first. */
export function parseYoutubeFeed(xml: string): Post[] {
  const author = tag(xml.split('<entry>')[0] ?? '', 'name') || tag(xml.split('<entry>')[0] ?? '', 'title');
  return xml.split('<entry>').slice(1).map((entry) => {
    const id = tag(entry, 'yt:videoId');
    const views = (entry.match(/<media:statistics[^>]*views="(\d+)"/) ?? [])[1];
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) ?? [])[1] ?? '';
    const p = video(id, { title: tag(entry, 'title'), author: tag(entry, 'name') || author, views: views ? `${views} views` : undefined, snippet: tag(entry, 'media:description'), short: link.includes('/shorts/') });
    p.publishedAt = tag(entry, 'published') || undefined;
    return p;
  }).filter((p) => p.id);
}

/** Caption JSON (`fmt=json3`): one line per caption event, newlines inside an event joined. */
export function parseJson3(json: unknown): TranscriptLine[] {
  const events = isObj(json) && Array.isArray(json.events) ? json.events : [];
  const lines: TranscriptLine[] = [];
  for (const e of events) {
    if (!isObj(e) || !Array.isArray(e.segs)) continue;
    const text = clean(e.segs.map((s) => (isObj(s) && typeof s.utf8 === 'string' ? s.utf8 : '')).join('').replace(/\n/g, ' '));
    if (text) lines.push({ startSec: Math.round((typeof e.tStartMs === 'number' ? e.tStartMs : 0) / 1000), text });
  }
  return lines;
}

/** Caption XML: `srv3` (`<p t="ms">`) or the older `<text start="s">`. */
export function parseCaptionXml(xml: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = clean(decodeXml(m[2].replace(/<[^>]+>/g, '')).replace(/\n/g, ' '));
    if (text) lines.push({ startSec: Math.round(Number(m[1]) / 1000), text });
  }
  if (lines.length) return lines;
  for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = clean(decodeXml(decodeXml(m[2])).replace(/<[^>]+>/g, '').replace(/\n/g, ' '));
    if (text) lines.push({ startSec: Math.round(Number(m[1])), text });
  }
  return lines;
}

/** The transcript panel's payload (`/youtubei/v1/get_transcript`): its segments in order. */
export function parseTranscriptPanel(json: unknown): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    const seg = v.transcriptSegmentRenderer;
    if (isObj(seg)) {
      const text = clean(ytText(seg.snippet));
      if (text) lines.push({ startSec: Math.round(Number(seg.startMs ?? 0) / 1000), text });
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(json);
  return lines;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  /** `asr`: generated by speech recognition. */
  kind?: string;
}

/** The caption tracks in the watch page's player response. */
export function parseCaptionTracks(player: unknown): CaptionTrack[] {
  const list = isObj(player) && isObj(player.captions) && isObj(player.captions.playerCaptionsTracklistRenderer)
    ? player.captions.playerCaptionsTracklistRenderer.captionTracks
    : undefined;
  return (Array.isArray(list) ? list : []).filter(isObj).map((t) => ({
    baseUrl: typeof t.baseUrl === 'string' ? t.baseUrl : '',
    languageCode: typeof t.languageCode === 'string' ? t.languageCode : '',
    name: ytText(t.name),
    ...(typeof t.kind === 'string' ? { kind: t.kind } : {}),
  })).filter((t) => t.baseUrl);
}

/**
 * The track to read: one made by people before a generated one, the video's own language (the
 * generated track's) before others, then the first listed.
 */
export function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const generated = tracks.find((t) => t.kind === 'asr');
  const own = generated?.languageCode;
  return tracks.find((t) => t.kind !== 'asr' && own && t.languageCode.split('-')[0] === own.split('-')[0])
    ?? tracks.find((t) => t.kind !== 'asr')
    ?? generated
    ?? null;
}

/** Title, channel and length from the watch page's player response. */
export function parseVideoDetails(player: unknown): Pick<Transcript, 'title' | 'author' | 'duration'> {
  const d = isObj(player) && isObj(player.videoDetails) ? player.videoDetails : {};
  const sec = Number(d.lengthSeconds);
  return {
    title: typeof d.title === 'string' ? d.title : undefined,
    author: typeof d.author === 'string' ? d.author : undefined,
    duration: Number.isFinite(sec) && sec > 0 ? formatDuration(sec) : undefined,
  };
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** The video id in a watch, shorts, embed or youtu.be URL, or a bare 11-character id. */
export function youtubeVideoId(ref: string): string | null {
  const s = ref.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
