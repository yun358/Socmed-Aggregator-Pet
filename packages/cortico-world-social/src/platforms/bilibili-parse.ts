/**
 * Bilibili's web API payloads read into posts and transcripts, and the WBI signature its `wbi/`
 * endpoints require (mixin key from the two key images `nav` names, MD5 over the sorted query).
 */
import { createHash } from 'node:crypto';
import { clean, type Post, type TranscriptLine } from '../posts.ts';
import { formatDuration } from './youtube-parse.ts';

export const BILIBILI_ORIGIN = 'https://www.bilibili.com';
export const BILIBILI_API = 'https://api.bilibili.com';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Search results mark the matched words with `<em class="keyword">`. */
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function video(v: Json, fields: { author?: string; duration?: string; views?: number | string; published?: number; text?: string }): Post | null {
  const bvid = str(v.bvid);
  if (!bvid) return null;
  const stats: Post['stats'] = [];
  if (fields.views !== undefined && fields.views !== '') stats.push(['views', String(fields.views)]);
  return {
    platform: 'bilibili',
    id: bvid,
    url: `${BILIBILI_ORIGIN}/video/${bvid}`,
    author: fields.author || undefined,
    title: clean(stripTags(str(v.title))),
    text: clean(fields.text),
    publishedAt: fields.published ? new Date(fields.published * 1000).toISOString() : undefined,
    stats,
    images: [],
    video: true,
    duration: fields.duration || undefined,
    extraction: 'adapter',
  };
}

const seconds = (v: unknown): string | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? formatDuration(n) : typeof v === 'string' && v ? v : undefined;
};

/**
 * The videos in any of the listings the adapter reads: search (`result`), popular (`list`), the home
 * recommendations (`item`, where only `goto: av` entries are videos) and an uploader's videos
 * (`list.vlist`).
 */
export function parseBilibiliVideos(json: unknown): Post[] {
  const data = isObj(json) && isObj(json.data) ? json.data : {};
  const raw: unknown[] = Array.isArray(data.result) ? data.result
    : Array.isArray(data.list) ? data.list
    : Array.isArray(data.item) ? data.item
    : isObj(data.list) && Array.isArray(data.list.vlist) ? data.list.vlist
    : Array.isArray(data.archives) ? data.archives
    : [];
  const out: Post[] = [];
  for (const v of raw) {
    if (!isObj(v)) continue;
    if (typeof v.goto === 'string' && v.goto !== 'av') continue;
    if (typeof v.type === 'string' && v.type !== 'video') continue;
    const owner = isObj(v.owner) ? v.owner : {};
    const stat = isObj(v.stat) ? v.stat : {};
    const p = video(v, {
      author: str(owner.name) || str(v.author),
      duration: seconds(v.duration) ?? (typeof v.length === 'string' ? v.length : undefined),
      views: num(stat.view) ?? num(v.play) ?? str(v.play),
      published: num(v.pubdate) ?? num(v.created),
      text: str(v.desc) || str(v.description),
    });
    if (p) out.push(p);
  }
  return out;
}

export interface BilibiliView {
  bvid: string;
  cid: number;
  title: string;
  author: string;
  duration?: string;
}

/** `x/web-interface/view`: the video's first part, whose `cid` the player and subtitles need. */
export function parseBilibiliView(json: unknown): BilibiliView | null {
  const d = isObj(json) && isObj(json.data) ? json.data : null;
  const cid = d ? num(d.cid) : undefined;
  if (!d || cid === undefined) return null;
  return { bvid: str(d.bvid), cid, title: str(d.title), author: isObj(d.owner) ? str(d.owner.name) : '', duration: seconds(d.duration) };
}

export interface BilibiliSubtitleTrack {
  url: string;
  language: string;
  /** Made by Bilibili's speech recognition (`ai-` languages). */
  generated: boolean;
}

/** `x/player/(wbi/)v2`: the subtitle tracks, and whether Bilibili says more need a login. */
export function parseBilibiliSubtitles(json: unknown): { tracks: BilibiliSubtitleTrack[]; needLogin: boolean } {
  const d = isObj(json) && isObj(json.data) ? json.data : {};
  const sub = isObj(d.subtitle) ? d.subtitle : {};
  const list = Array.isArray(sub.subtitles) ? sub.subtitles : [];
  const tracks = list.filter(isObj).map((t) => {
    const lan = str(t.lan);
    const url = str(t.subtitle_url);
    return { url: url.startsWith('//') ? `https:${url}` : url, language: str(t.lan_doc) || lan, generated: lan.startsWith('ai-') || num(t.type) === 1 };
  }).filter((t) => t.url);
  return { tracks, needLogin: d.need_login_subtitle === true };
}

/** A subtitle file: `{ body: [{ from, content }] }`. */
export function parseBilibiliSubtitleBody(json: unknown): TranscriptLine[] {
  const body = isObj(json) && Array.isArray(json.body) ? json.body : [];
  return body.filter(isObj).map((l) => ({ startSec: Math.round(num(l.from) ?? 0), text: clean(str(l.content)) })).filter((l) => l.text);
}

/** `search_type=bili_user`: the best-matching uploader's id. */
export function parseBilibiliUser(json: unknown): { mid: number; name: string } | null {
  const d = isObj(json) && isObj(json.data) ? json.data : {};
  const first = Array.isArray(d.result) ? d.result.find(isObj) : undefined;
  const mid = first ? num(first.mid) : undefined;
  return first && mid !== undefined ? { mid, name: stripTags(str(first.uname)) } : null;
}

/** The BV id in a video URL, or a bare BV id. */
export function bilibiliVideoId(ref: string): string | null {
  const m = ref.trim().match(/\b(BV[0-9A-Za-z]{10})\b/);
  return m ? m[1] : null;
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** The two keys are the file names, without extension, of `nav`'s `wbi_img.img_url` and `sub_url`. */
export function wbiKeys(nav: unknown): { imgKey: string; subKey: string } | null {
  const img = isObj(nav) && isObj(nav.data) && isObj(nav.data.wbi_img) ? nav.data.wbi_img : null;
  const stem = (u: unknown) => str(u).split('/').pop()?.split('.')[0] ?? '';
  const imgKey = stem(img?.img_url);
  const subKey = stem(img?.sub_url);
  return imgKey && subKey ? { imgKey, subKey } : null;
}

export function wbiMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** `params` with `wts` (seconds) and `w_rid` added, as a query string. */
export function wbiSign(params: Record<string, string | number>, keys: { imgKey: string; subKey: string }, wts: number): string {
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + wbiMixinKey(keys.imgKey, keys.subKey)).digest('hex');
  return `${query}&w_rid=${wRid}`;
}
