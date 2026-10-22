/**
 * Gathering posts within a request's limits. Adapters offer every post they find to a `Collector`,
 * which applies the rules in one place: video posts are left out on the platforms that are not video
 * platforms, posts with images are left out when images are skipped (text only), ads are always left
 * out, and gathering stops at the wanted count or when the time is up.
 */
import type { PageSession } from './browser.ts';
import type { ImageMode } from './config.ts';
import { DOM_READ_DEFAULTS, readGenericPosts, scrollDown, type DomPost, type DomReadOptions } from './platforms/dom.ts';
import { VIDEO_PLATFORMS, clean, type PlatformId, type Post } from './posts.ts';

/** How a gathering ended. */
export type StopReason = 'count' | 'time' | 'end' | 'interrupted';

/** Why a platform would not show what was asked. */
export type BlockKind = 'login' | 'captcha' | 'consent' | 'blocked';

export class PlatformBlocked extends Error {
  constructor(readonly platform: PlatformId, readonly kind: BlockKind, readonly detail = '') {
    super(`${platform}: ${kind}${detail ? ` (${detail})` : ''}`);
  }
}

/** A clock and a deadline: the part of a request's time this call may spend. */
export class Deadline {
  readonly startedAtMs: number;
  constructor(private readonly ms: number, private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }
  get elapsedMs(): number { return this.now() - this.startedAtMs; }
  get leftMs(): number { return Math.max(0, this.ms - this.elapsedMs); }
  get up(): boolean { return this.leftMs <= 0; }
}

export interface Skipped {
  video: number;
  image: number;
  ad: number;
}

export class Collector {
  readonly posts: Post[] = [];
  readonly skipped: Skipped = { video: 0, image: 0, ad: 0 };
  private readonly seen = new Set<string>();
  /** Some posts came from the generic reader. */
  generic = false;

  constructor(
    readonly platform: PlatformId,
    readonly want: number,
    readonly images: ImageMode,
    readonly deadline: Deadline,
  ) {}

  get full(): boolean { return this.posts.length >= this.want; }
  get done(): boolean { return this.full || this.deadline.up; }

  /** Whether a post with this id and link was offered before. */
  offeredBefore(id: string, url: string): boolean {
    return this.seen.has(`${id}|${url}`);
  }

  /** Takes `post` unless a rule leaves it out or it was offered before; false once no more are wanted. */
  offer(post: Post, ad = false): boolean {
    if (this.done) return false;
    const key = `${post.id}|${post.url}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (ad) this.skipped.ad++;
    else if (post.video && !VIDEO_PLATFORMS.has(this.platform)) this.skipped.video++;
    else if (this.images === 'skip' && post.images.length) this.skipped.image++;
    else {
      this.posts.push(post);
      if (post.extraction === 'generic') this.generic = true;
    }
    return !this.done;
  }

  stopReason(interrupted: boolean): StopReason {
    if (interrupted) return 'interrupted';
    if (this.full) return 'count';
    if (this.deadline.up) return 'time';
    return 'end';
  }
}

/** A post the page shows, as a `Post`. */
export function domToPost(platform: PlatformId, p: DomPost, extraction: Post['extraction']): Post {
  return {
    platform,
    id: p.url || p.key,
    url: p.url,
    author: p.author || undefined,
    text: clean(p.text) + (p.truncated ? ' …' : ''),
    publishedAt: p.time || undefined,
    publishedText: p.timeText || undefined,
    stats: p.stats.filter(([, v]) => v),
    images: p.images.map((i) => ({ url: i.url, ...(i.alt ? { alt: i.alt } : {}) })),
    video: p.video,
    extraction,
  };
}

/** Pause between scrolls, long enough for the next posts to load. */
export const SCROLL_PAUSE_MS = 1500;
/** Scrolls in a row that bring nothing new before the page counts as ended. */
export const STALE_SCROLLS = 3;

export interface ScrollOptions {
  /** Reads the posts the page shows; null reads with the generic reader only. */
  reader: ((opts: DomReadOptions) => DomPost[]) | null;
  /** Runs before each read, such as expanding "see more". */
  beforeRead?: () => Promise<void>;
  /** The page's own posts appear under this selector; waited for before the first read. */
  ready?: string;
  /** Rewrites each post before it is offered, such as asking for a larger image rendition. */
  adjust?: (post: Post) => Post;
}

/**
 * Reads the page, scrolls, and reads again until the collector is done or the page brings nothing
 * new. When the platform's reader finds nothing on the first screen, the generic reader takes over.
 */
export async function scrollCollect(page: PageSession, collector: Collector, opts: ScrollOptions): Promise<void> {
  if (opts.ready) await page.waitFor(opts.ready, Math.min(10_000, collector.deadline.leftMs));
  let reader = opts.reader;
  let extraction: Post['extraction'] = reader ? 'adapter' : 'generic';
  const keys = new Set<string>();
  let stale = 0;
  for (let first = true; !collector.done; first = false) {
    await opts.beforeRead?.();
    let found = reader ? await page.run(reader, DOM_READ_DEFAULTS) : [];
    if (first && reader && !found.length) {
      reader = null;
      extraction = 'generic';
    }
    if (!reader) found = await page.run(readGenericPosts, DOM_READ_DEFAULTS);
    let fresh = 0;
    for (const p of found) {
      if (keys.has(p.key)) continue;
      keys.add(p.key);
      fresh++;
      const post = domToPost(collector.platform, p, extraction);
      if (!collector.offer(opts.adjust ? opts.adjust(post) : post, p.ad)) break;
    }
    if (collector.done) break;
    stale = fresh ? 0 : stale + 1;
    if (stale >= STALE_SCROLLS) break;
    const moved = await page.run(scrollDown, undefined);
    if (!moved && !fresh) break;
    await page.pause(Math.min(SCROLL_PAUSE_MS, collector.deadline.leftMs));
  }
}
