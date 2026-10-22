/** Posts, transcripts and digest pages as the lines of a receipt, in the model-text language. */
import type { ModelText } from './model-text.ts';
import { VIDEO_PLATFORMS, type Post, type Transcript } from './posts.ts';

/** Characters of a post's text in a listing; `social_read` shows the rest. */
export const POST_TEXT_MAX = 1200;
/** Characters of one image's OCR text. */
export const OCR_TEXT_MAX = 800;
/** Characters of one comment. */
export const COMMENT_TEXT_MAX = 1000;
/** A transcript line block starts at least this many seconds after the previous one. */
export const BLOCK_SEC = 30;

/** `iso` as local `YYYY-MM-DD HH:MM` in `timezone`; the input unchanged when it is no date. */
export function localStamp(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Text from the platform kept to the line it is labelled on, or quoted with `> ` before each line,
 * so it cannot pass for a receipt or event line.
 */
export const oneLine = (s: string, max = Infinity): string => cap(s.replace(/\s*\n\s*/g, ' / '), max);
const quote = (s: string): string => s.split('\n').map((l) => `> ${l}`).join('\n');

/** One post: its heading line, title, text (cut at `textMax`), what its images said, and its link. */
export function renderPost(t: ModelText, i: number, p: Post, timezone: string, textMax = POST_TEXT_MAX): string {
  const when = p.publishedAt ? localStamp(p.publishedAt, timezone) : p.publishedText;
  const stats = p.stats.map(([k, v]) => (k ? `${k} ${v}` : v));
  const videoItem = p.video && VIDEO_PLATFORMS.has(p.platform);
  const head = videoItem
    ? [p.title ? `"${p.title}"` : '', p.author, p.duration, ...stats, when]
    : [p.community, p.author, when, ...stats];
  const lines = [t.postHead(i, head.filter((x): x is string => !!x).map((x) => oneLine(x)))];
  if (p.title && !videoItem) lines.push(t.title(oneLine(p.title)));
  if (p.text) {
    const long = p.text.length > textMax;
    lines.push(quote(long ? p.text.slice(0, textMax) : p.text) + (long ? t.cut(p.text.length) : ''));
  }
  for (const [n, image] of p.images.entries()) {
    const k = n + 1;
    if (image.alt) lines.push(t.imageAlt(k, oneLine(image.alt)));
    const r = image.read;
    if (!r) continue;
    if (r.kind === 'ocr') {
      if (r.text) lines.push(t.imageOcr(k, oneLine(r.text, OCR_TEXT_MAX)));
      else if (!image.alt) lines.push(t.imageOcrNone(k));
    } else if (r.kind === 'attached') lines.push(t.imageAttached(k, r.n));
    else lines.push(t.imageUnread(k, r.why));
  }
  if (p.url) lines.push(p.url);
  return lines.join('\n');
}

export interface RenderedTranscript {
  text: string;
  /** Where the next call starts, null when the transcript was shown to its end. */
  nextSec: number | null;
}

/** The lines from `fromSec` on in blocks of about `BLOCK_SEC`, up to `maxChars` characters. */
export function renderTranscript(t: ModelText, tr: Transcript, fromSec: number, maxChars: number): RenderedTranscript {
  const blocks: Array<{ start: number; text: string }> = [];
  for (const line of tr.lines) {
    if (line.startSec < fromSec) continue;
    const last = blocks[blocks.length - 1];
    if (last && line.startSec - last.start < BLOCK_SEC) last.text += ` ${oneLine(line.text)}`;
    else blocks.push({ start: line.startSec, text: oneLine(line.text) });
  }
  const out: string[] = [];
  let used = 0;
  let nextSec: number | null = null;
  for (const b of blocks) {
    const row = `[${clock(b.start)}] ${b.text}`;
    if (out.length && used + row.length > maxChars) { nextSec = b.start; break; }
    out.push(row);
    used += row.length + 1;
  }
  const lastLine = tr.lines[tr.lines.length - 1];
  const total = tr.duration ?? (lastLine ? clock(lastLine.startSec) : '0:00');
  const shownTo = nextSec ?? Math.max(fromSec, lastLine ? lastLine.startSec : 0);
  const head = t.transcriptHead(oneLine(tr.title ?? t.untitled), oneLine(tr.author ?? ''), tr.duration ?? total, tr.language ?? '', tr.generated);
  const span = t.transcriptSpan(clock(blocks[0]?.start ?? fromSec), clock(shownTo), total, nextSec === null);
  const tail = nextSec === null ? [] : [t.transcriptMore(nextSec, maxChars)];
  return { text: [head, span, ...out, ...tail].join('\n'), nextSec };
}

/** Posts from `offset` on, rendered until about `maxChars`; returns the offset after the last shown. */
export function renderPage(t: ModelText, posts: Post[], offset: number, maxChars: number, timezone: string, textMax: number): { text: string; next: number } {
  const out: string[] = [];
  let used = 0;
  let i = offset;
  for (; i < posts.length; i++) {
    const block = renderPost(t, i + 1, posts[i], timezone, textMax);
    if (out.length && used + block.length > maxChars) break;
    out.push(block);
    used += block.length + 2;
  }
  return { text: out.join('\n\n'), next: i };
}
