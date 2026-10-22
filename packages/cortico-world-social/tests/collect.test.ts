/** collect.ts: the rules every listing goes through, and reading a page while scrolling it. */
import { describe, expect, it } from 'vitest';
import type { FetchedText, PageSession } from '../src/browser.ts';
import { Collector, Deadline, SCROLL_PAUSE_MS, STALE_SCROLLS, domToPost, scrollCollect } from '../src/collect.ts';
import type { ImageMode } from '../src/config.ts';
import { readGenericPosts, scrollDown, type DomPost, type DomReadOptions } from '../src/platforms/dom.ts';
import { PLATFORM_IDS, VIDEO_PLATFORMS, type PlatformId, type Post } from '../src/posts.ts';

const post = (id: string, over: Partial<Post> = {}): Post => ({
  platform: 'reddit', id, url: `https://fixture.test/p/${id}`, text: `text ${id}`, stats: [], images: [], video: false, extraction: 'adapter', ...over,
});
const withImage = { images: [{ url: 'https://fixture.test/i.png' }] };

/** A clock the test moves. */
const manualClock = () => {
  const c = { now: 0, read: () => c.now };
  return c;
};
const collector = (platform: PlatformId, want: number, images: ImageMode = 'ocr', ms = 60_000, now: () => number = () => 0) =>
  new Collector(platform, want, images, new Deadline(ms, now));

describe('Deadline', () => {
  it('counts the time spent and left on its clock, never below zero', () => {
    const clock = manualClock();
    const d = new Deadline(1000, clock.read);
    clock.now = 400;
    expect([d.elapsedMs, d.leftMs, d.up]).toEqual([400, 600, false]);
    clock.now = 1500;
    expect([d.elapsedMs, d.leftMs, d.up]).toEqual([1500, 0, true]);
  });
});

describe('Collector', () => {
  it('takes posts until the wanted count; the post that fills it ends the gathering', () => {
    const c = collector('reddit', 2);
    expect(c.offer(post('a'))).toBe(true);
    expect(c.offer(post('b'))).toBe(false);
    expect(c.offer(post('c'))).toBe(false);
    expect(c.posts.map((p) => p.id)).toEqual(['a', 'b']);
    expect(c.stopReason(false)).toBe('count');
  });

  it('leaves ads out on every platform and counts them', () => {
    for (const platform of PLATFORM_IDS) {
      const c = collector(platform, 5);
      expect(c.offer(post('ad', { platform, video: VIDEO_PLATFORMS.has(platform) }), true)).toBe(true);
      expect(c.posts, platform).toEqual([]);
      expect(c.skipped, platform).toEqual({ video: 0, image: 0, ad: 1 });
    }
  });

  it('leaves video posts out and counts them except on the video platforms', () => {
    for (const platform of PLATFORM_IDS) {
      const c = collector(platform, 5);
      c.offer(post('v', { platform, video: true }));
      if (VIDEO_PLATFORMS.has(platform)) expect(c.posts.map((p) => p.id), platform).toEqual(['v']);
      else expect([c.posts.length, c.skipped.video], platform).toEqual([0, 1]);
    }
  });

  it('in text-only mode leaves posts with images out and counts them; the other modes keep them', () => {
    const textOnly = collector('instagram', 5, 'skip');
    textOnly.offer(post('img', withImage));
    textOnly.offer(post('txt'));
    textOnly.offer(post('clip', { ...withImage, video: true }));
    expect(textOnly.posts.map((p) => p.id)).toEqual(['txt']);
    expect(textOnly.skipped).toEqual({ video: 1, image: 1, ad: 0 });
    for (const mode of ['ocr', 'model'] as const) {
      const c = collector('instagram', 5, mode);
      c.offer(post('img', withImage));
      expect(c.posts.map((p) => p.id), mode).toEqual(['img']);
    }
  });

  it('takes a post offered twice once, and goes on gathering', () => {
    const c = collector('x', 5);
    expect(c.offer(post('a'))).toBe(true);
    expect(c.offer(post('a'))).toBe(true);
    expect(c.offer(post('a'), true)).toBe(true);
    expect(c.posts).toHaveLength(1);
    expect(c.skipped).toEqual({ video: 0, image: 0, ad: 0 });
  });

  it('takes nothing once the time is up, and says so', () => {
    const clock = manualClock();
    const c = collector('threads', 5, 'ocr', 1000, clock.read);
    clock.now = 999;
    expect(c.offer(post('a'))).toBe(true);
    clock.now = 1000;
    expect(c.offer(post('b'))).toBe(false);
    expect(c.posts.map((p) => p.id)).toEqual(['a']);
    expect(c.stopReason(false)).toBe('time');
  });

  it('reports an interruption first, and the end of the listing when neither limit was reached', () => {
    const c = collector('facebook', 5);
    c.offer(post('a'));
    expect(c.stopReason(true)).toBe('interrupted');
    expect(c.stopReason(false)).toBe('end');
  });

  it('notes when a post it took came from the generic reader', () => {
    const c = collector('rednote', 5);
    c.offer(post('ad', { extraction: 'generic' }), true);
    expect(c.generic).toBe(false);
    c.offer(post('g', { extraction: 'generic' }));
    expect(c.generic).toBe(true);
  });
});

const dom = (key: string, over: Partial<DomPost> = {}): DomPost => ({
  key, url: `https://fixture.test/p/${key}`, author: 'fixture_user', text: `text ${key}`, time: '', timeText: '',
  images: [], video: false, stats: [], ad: false, truncated: false, ...over,
});

describe('domToPost', () => {
  it("turns what the page shows into a post: the link as id, text cleaned and marked when cut, empty fields left out", () => {
    const p = domToPost('threads', dom('k1', {
      text: 'line one  \n\n  line two', truncated: true, time: '2026-10-22T01:00:00.000Z', timeText: '3h',
      images: [{ url: 'https://fixture.test/a.jpg', alt: '' }, { url: 'https://fixture.test/b.jpg', alt: 'A bowl of noodles' }],
      stats: [['likes', '12'], ['replies', '']],
    }), 'adapter');
    expect(p).toEqual({
      platform: 'threads',
      id: 'https://fixture.test/p/k1',
      url: 'https://fixture.test/p/k1',
      author: 'fixture_user',
      text: 'line one\nline two …',
      publishedAt: '2026-10-22T01:00:00.000Z',
      publishedText: '3h',
      stats: [['likes', '12']],
      images: [{ url: 'https://fixture.test/a.jpg' }, { url: 'https://fixture.test/b.jpg', alt: 'A bowl of noodles' }],
      video: false,
      extraction: 'adapter',
    });
  });

  it('identifies a post without a link by its key', () => {
    const p = domToPost('facebook', dom('author:text', { url: '', author: '' }), 'generic');
    expect([p.id, p.url, p.author, p.extraction]).toEqual(['author:text', '', undefined, 'generic']);
  });
});

/**
 * A page that answers the in-page readers with scripted screens: each scroll that moves shows the
 * next screen, and past the last one the page keeps showing the last.
 */
class ScriptedPage implements PageSession {
  screen = 0;
  readonly log: string[] = [];

  constructor(
    private readonly reader: (opts: DomReadOptions) => DomPost[],
    private readonly script: { reader: DomPost[][]; generic?: DomPost[][]; moves?: boolean },
    private readonly clock?: { now: number },
  ) {}

  private shown(screens: DomPost[][] | undefined): DomPost[] {
    return screens?.length ? screens[Math.min(this.screen, screens.length - 1)] : [];
  }

  async run<A, R>(fn: (arg: A) => R | Promise<R>): Promise<R> {
    const f = fn as unknown;
    if (f === this.reader) { this.log.push('read'); return this.shown(this.script.reader) as R; }
    if (f === readGenericPosts) { this.log.push('generic'); return this.shown(this.script.generic) as R; }
    if (f === scrollDown) {
      this.log.push('scroll');
      const moved = this.script.moves ?? true;
      if (moved) this.screen++;
      return moved as R;
    }
    throw new Error('the page was asked to run a function it does not know');
  }

  async waitFor(selector: string): Promise<boolean> { this.log.push(`wait ${selector}`); return true; }
  async pause(ms: number): Promise<void> { this.log.push('pause'); if (this.clock) this.clock.now += ms; }
  async goto(url: string): Promise<string> { return url; }
  async fetchText(): Promise<FetchedText> { throw new Error('no network in this page'); }
  async fetchRaw(): Promise<null> { return null; }
  async captureResponse(): Promise<null> { return null; }
  check(): void {}
  url(): string { return 'https://fixture.test/'; }
}

/** The platform's own reader; the scripted page answers for it. */
const platformReader = (_opts: DomReadOptions): DomPost[] => [];

describe('scrollCollect', () => {
  it('reads, scrolls and reads again, offering each post once in page order', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a'), dom('b')], [dom('b'), dom('c'), dom('d', { ad: true })], [dom('e')]] });
    const c = collector('x', 10);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.posts.map((p) => p.id)).toEqual(['a', 'b', 'c', 'e'].map((k) => `https://fixture.test/p/${k}`));
    expect(c.posts.every((p) => p.extraction === 'adapter')).toBe(true);
    expect(c.skipped.ad).toBe(1);
    expect(page.log).not.toContain('generic');
  });

  it(`ends after ${STALE_SCROLLS} scrolls in a row bring nothing new`, async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a'), dom('b')]] });
    const c = collector('x', 10);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.posts).toHaveLength(2);
    expect(page.log.filter((e) => e === 'scroll')).toHaveLength(STALE_SCROLLS);
    expect(c.stopReason(false)).toBe('end');
  });

  it('ends when the page no longer moves and shows nothing new', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a')]], moves: false });
    await scrollCollect(page, collector('x', 10), { reader: platformReader });
    expect(page.log).toEqual(['read', 'scroll', 'pause', 'read', 'scroll']);
  });

  it('stops in the middle of a screen at the wanted count, without scrolling further', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a'), dom('b'), dom('c'), dom('d')]] });
    const c = collector('x', 3);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.posts).toHaveLength(3);
    expect(page.log).toEqual(['read']);
    expect(c.stopReason(false)).toBe('count');
  });

  it('falls back to the generic reader when the platform reader finds nothing on the first screen, and keeps to it', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[], [dom('late')]], generic: [[dom('g1')], [dom('g1'), dom('g2')]] });
    const c = collector('threads', 2);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.posts.map((p) => [p.id, p.extraction])).toEqual([['https://fixture.test/p/g1', 'generic'], ['https://fixture.test/p/g2', 'generic']]);
    expect(c.generic).toBe(true);
    expect(page.log.filter((e) => e === 'read')).toHaveLength(1);
  });

  it('reads with the generic reader alone when the platform has none', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('never')]], generic: [[dom('g1')]] });
    const c = collector('facebook', 1);
    await scrollCollect(page, c, { reader: null });
    expect(c.posts.map((p) => p.extraction)).toEqual(['generic']);
    expect(page.log).toEqual(['generic']);
  });

  it('does not fall back when the platform reader comes up empty after the first screen', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a')], []], generic: [[dom('g1')]] });
    const c = collector('instagram', 5);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.posts.map((p) => p.extraction)).toEqual(['adapter']);
    expect(page.log).not.toContain('generic');
  });

  it('pauses between scrolls on the deadline clock and stops when the time is up', async () => {
    const clock = { now: 0 };
    const screens = Array.from({ length: 10 }, (_, i) => [dom(`p${i}`)]);
    const page = new ScriptedPage(platformReader, { reader: screens }, clock);
    const c = collector('x', 100, 'ocr', 2 * SCROLL_PAUSE_MS, () => clock.now);
    await scrollCollect(page, c, { reader: platformReader });
    expect(c.stopReason(false)).toBe('time');
    expect(clock.now).toBe(2 * SCROLL_PAUSE_MS);
    expect(c.posts.map((p) => p.text)).toEqual(['text p0', 'text p1']);
  });

  it('waits for the ready selector first, runs the before-read step before every read, and rewrites each post', async () => {
    const page = new ScriptedPage(platformReader, { reader: [[dom('a')], [dom('b')]] });
    const c = collector('facebook', 2);
    await scrollCollect(page, c, {
      reader: platformReader,
      ready: 'div[role="feed"]',
      beforeRead: async () => { page.log.push('expand'); },
      adjust: (p) => ({ ...p, text: p.text.toUpperCase() }),
    });
    expect(page.log).toEqual(['wait div[role="feed"]', 'expand', 'read', 'scroll', 'pause', 'expand', 'read']);
    expect(c.posts.map((p) => p.text)).toEqual(['TEXT A', 'TEXT B']);
  });
});
