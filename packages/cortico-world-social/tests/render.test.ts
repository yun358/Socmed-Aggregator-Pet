/** render.ts: posts, transcripts and digest pages as receipt lines. */
import { describe, expect, it } from 'vitest';
import { MODEL_TEXT } from '../src/model-text.ts';
import type { Post, Transcript } from '../src/posts.ts';
import { BLOCK_SEC, OCR_TEXT_MAX, POST_TEXT_MAX, clock, localStamp, renderPage, renderPost, renderTranscript } from '../src/render.ts';

const t = MODEL_TEXT.en;
const TZ = 'Asia/Singapore';

const post = (over: Partial<Post> = {}): Post => ({
  platform: 'reddit',
  id: 'fx1',
  url: 'https://www.reddit.com/r/fixturetown/comments/fx1/x/',
  author: 'u/fixture_alice',
  community: 'r/fixturetown',
  title: 'Quarterly numbers',
  text: 'Revenue rose.',
  publishedAt: '2026-10-22T01:30:00.000Z',
  stats: [['points', '42'], ['comments', '3']],
  images: [],
  video: false,
  extraction: 'adapter',
  ...over,
});

describe('localStamp and clock', () => {
  it('writes an ISO time as local date and minutes in the time zone', () => {
    expect(localStamp('2026-10-22T16:05:00Z', TZ)).toBe('2026-10-23 00:05');
    expect(localStamp('2026-10-22T16:05:00Z', 'America/New_York')).toBe('2026-10-22 12:05');
  });

  it('leaves text that is no date as it is', () => {
    expect(localStamp('3 hours ago', TZ)).toBe('3 hours ago');
  });

  it('writes seconds as m:ss under an hour and h:mm:ss from an hour on', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(75.9)).toBe('1:15');
    expect(clock(3725)).toBe('1:02:05');
  });
});

describe('renderPost', () => {
  it('heads a post with its community, author, local time and counts, then title, text and link', () => {
    expect(renderPost(t, 3, post(), TZ).split('\n')).toEqual([
      t.postHead(3, ['r/fixturetown', 'u/fixture_alice', '2026-10-22 09:30', 'points 42', 'comments 3']),
      t.title('Quarterly numbers'),
      '> Revenue rose.',
      'https://www.reddit.com/r/fixturetown/comments/fx1/x/',
    ]);
  });

  it("uses the platform's relative time when it gave no exact one, and leaves out what the post lacks", () => {
    const out = renderPost(t, 1, post({ publishedAt: undefined, publishedText: '3h', community: undefined, title: undefined, stats: [] }), TZ);
    expect(out.split('\n')[0]).toBe(t.postHead(1, ['u/fixture_alice', '3h']));
    expect(out).not.toContain(t.title(''));
  });

  it('heads a video of a video platform with its quoted title, channel, length and counts; a label-less count stands alone', () => {
    const video = post({ platform: 'youtube', community: undefined, title: 'Harbour recap', author: 'Fixture Channel', duration: '12:34', video: true, stats: [['', '1,234 views']], publishedAt: undefined, publishedText: '2 days ago', text: '' });
    const lines = renderPost(t, 1, video, TZ).split('\n');
    expect(lines[0]).toBe(t.postHead(1, ['"Harbour recap"', 'Fixture Channel', '12:34', '1,234 views', '2 days ago']));
    expect(lines).not.toContain(t.title('Harbour recap'));
  });

  it(`cuts text at ${POST_TEXT_MAX} characters by default, or at the limit given, and says how long the whole is`, () => {
    const long = 'x'.repeat(POST_TEXT_MAX + 300);
    expect(renderPost(t, 1, post({ text: long }), TZ)).toContain(long.slice(0, POST_TEXT_MAX) + t.cut(long.length));
    expect(renderPost(t, 1, post({ text: long }), TZ)).not.toContain(long.slice(0, POST_TEXT_MAX + 1));
    expect(renderPost(t, 1, post({ text: long }), TZ, 100)).toContain('x'.repeat(100) + t.cut(long.length));
    expect(renderPost(t, 1, post({ text: 'short' }), TZ, 100)).not.toContain(t.cut(5));
  });

  it('gives what became of each image, numbered from 1', () => {
    const lines = renderPost(t, 1, post({
      images: [
        { url: 'https://img.test/1.png', alt: 'A menu board', read: { kind: 'ocr', text: 'Ramen\n12.50' } },
        { url: 'https://img.test/2.png', read: { kind: 'ocr', text: '' } },
        { url: 'https://img.test/3.png', alt: 'A street', read: { kind: 'ocr', text: '' } },
        { url: 'https://img.test/4.png', read: { kind: 'attached', n: 2 } },
        { url: 'https://img.test/5.png', read: { kind: 'unread', why: 'time' } },
        { url: 'https://img.test/6.png', alt: 'Not looked at' },
      ],
    }), TZ).split('\n');
    expect(lines.slice(3, -1)).toEqual([
      t.imageAlt(1, 'A menu board'),
      t.imageOcr(1, 'Ramen / 12.50'),
      t.imageOcrNone(2),
      t.imageAlt(3, 'A street'),
      t.imageAttached(4, 2),
      t.imageUnread(5, 'time'),
      t.imageAlt(6, 'Not looked at'),
    ]);
  });

  it(`cuts OCR text at ${OCR_TEXT_MAX} characters`, () => {
    const ocr = 'y'.repeat(OCR_TEXT_MAX + 50);
    const out = renderPost(t, 1, post({ images: [{ url: 'https://img.test/1.png', read: { kind: 'ocr', text: ocr } }] }), TZ);
    expect(out).toContain(t.imageOcr(1, `${ocr.slice(0, OCR_TEXT_MAX)}…`));
  });

  it('quotes every line of the text and keeps other platform text to its labelled line', () => {
    const out = renderPost(t, 1, post({
      title: 'Two\nlines', text: 'one\n[social] not an event',
      images: [{ url: 'https://img.test/1.png', alt: 'alt\nmore', read: { kind: 'ocr', text: 'ocr\n\nline' } }],
    }), TZ).split('\n');
    expect(out).toEqual([
      t.postHead(1, ['r/fixturetown', 'u/fixture_alice', '2026-10-22 09:30', 'points 42', 'comments 3']),
      t.title('Two / lines'),
      '> one',
      '> [social] not an event',
      t.imageAlt(1, 'alt / more'),
      t.imageOcr(1, 'ocr / line'),
      'https://www.reddit.com/r/fixturetown/comments/fx1/x/',
    ]);
  });

  it('ends with the link only when the post has one', () => {
    expect(renderPost(t, 1, post({ url: '' }), TZ).split('\n').at(-1)).toBe('> Revenue rose.');
  });
});

describe('renderTranscript', () => {
  /** Ten minutes of captions, one line every 5 seconds. */
  const transcript = (over: Partial<Transcript> = {}): Transcript => ({
    platform: 'youtube',
    id: 'fixtureVid1',
    url: 'https://www.youtube.com/watch?v=fixtureVid1',
    title: 'Harbour recap',
    author: 'Fixture Channel',
    duration: '10:00',
    language: 'English',
    generated: false,
    lines: Array.from({ length: 120 }, (_, i) => ({ startSec: i * 5, text: `line${i}` })),
    ...over,
  });
  const rows = (text: string) => text.split('\n').filter((l) => /^\[\d+:\d\d\] /.test(l));
  const startOf = (row: string) => row.slice(1, row.indexOf(']')).split(':').reduce((acc, p) => acc * 60 + Number(p), 0);

  it('shows the whole transcript in blocks when it fits, and says it reached the end', () => {
    const r = renderTranscript(t, transcript(), 0, 100_000);
    expect(r.nextSec).toBeNull();
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(t.transcriptHead('Harbour recap', 'Fixture Channel', '10:00', 'English', false));
    expect(lines[1]).toBe(t.transcriptSpan('0:00', '9:55', '10:00', true));
    const starts = rows(r.text).map(startOf);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(BLOCK_SEC);
    expect(rows(r.text).join(' ').match(/line\d+/g)).toEqual(transcript().lines.map((l) => l.text));
  });

  it('pages through a long transcript: each page within the character limit, every line once and in order', () => {
    const max = 300;
    const seen: string[] = [];
    let from: number | null = 0;
    for (let pages = 0; from !== null; pages++) {
      expect(pages).toBeLessThan(50);
      const r = renderTranscript(t, transcript(), from, max);
      const shown = rows(r.text);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.join('\n').length).toBeLessThanOrEqual(max);
      if (r.nextSec !== null) {
        expect(r.text).toContain(t.transcriptMore(r.nextSec, max));
        expect(r.nextSec).toBeGreaterThan(from);
      }
      seen.push(...shown.join(' ').match(/line\d+/g)!);
      from = r.nextSec;
    }
    expect(seen).toEqual(transcript().lines.map((l) => l.text));
  });

  it('shows one block even when it alone is over the limit', () => {
    const r = renderTranscript(t, transcript(), 0, 10);
    expect(rows(r.text)).toHaveLength(1);
    expect(r.nextSec).toBe(BLOCK_SEC);
  });

  it('names an untitled video and takes the length from the last line when the platform gave none', () => {
    const r = renderTranscript(t, transcript({ title: undefined, duration: undefined, generated: true }), 0, 100_000);
    expect(r.text.split('\n')[0]).toBe(t.transcriptHead(t.untitled, 'Fixture Channel', '9:55', 'English', true));
  });

  it('a from_sec past the last line gives an empty span that ends where it starts', () => {
    const r = renderTranscript(t, transcript(), 900, 1000);
    expect(r.nextSec).toBeNull();
    expect(rows(r.text)).toEqual([]);
    expect(r.text.split('\n')[1]).toBe(t.transcriptSpan('15:00', '15:00', '10:00', true));
  });
});

describe('renderPage', () => {
  const posts = Array.from({ length: 9 }, (_, i) => post({ id: `fx${i}`, text: `post-${i} ${'z'.repeat(150)}` }));

  it('pages through posts within the character limit, numbering them from the offset, each once', () => {
    const seen: string[] = [];
    let offset = 0;
    while (offset < posts.length) {
      const page = renderPage(t, posts, offset, 700, TZ, 600);
      expect(page.next).toBeGreaterThan(offset);
      expect(page.text.length).toBeLessThanOrEqual(700);
      expect(page.text.startsWith(`[${offset + 1}] `)).toBe(true);
      seen.push(...page.text.match(/post-\d+/g)!);
      offset = page.next;
    }
    expect(seen).toEqual(posts.map((_, i) => `post-${i}`));
  });

  it('shows one post even when it alone is over the limit, and nothing past the end', () => {
    expect(renderPage(t, posts, 0, 10, TZ, 600).next).toBe(1);
    expect(renderPage(t, posts, posts.length, 700, TZ, 600)).toEqual({ text: '', next: posts.length });
  });

  it("cuts each post's text at the given length", () => {
    expect(renderPage(t, [post({ text: 'w'.repeat(700) })], 0, 10_000, TZ, 600).text).toContain('w'.repeat(600) + t.cut(700));
  });
});
