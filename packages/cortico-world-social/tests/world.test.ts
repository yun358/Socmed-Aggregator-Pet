/**
 * SocialWorld without a browser: the tools, the per-request limits, refusals, blocks and
 * interruptions, the lifetime counter, the panel, the daily autoscroll, comment drafts, the queue of
 * automatic posts, and Substack's Notes, post drafts and daily Notes. Pages are `ScriptedBrowser`
 * pages answering Reddit's, Bilibili's and Substack's JSON, timed on a test clock.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getByPath } from 'cortico/core/config-schema.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import type { ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { DigestStore, digestId, jobKey, localClock } from '../src/autoscroll.ts';
import type { FetchedText } from '../src/browser.ts';
import { DRAFTS_MAX } from '../src/comments.ts';
import {
  COMMENTS_PER_DAY_CAP, DAILY_NOTES_CAP, JOB_POSTS_CAP, MAX_JOBS, MAX_POSTS_CAP, MAX_SEC_CAP, NOTES_PER_DAY_CAP, SOCIAL_DEFAULTS, parseJobs, type AutoscrollJob, type SocialConfigSection,
} from '../src/config.ts';
import { SOCIAL } from '../src/definition.ts';
import { findBrowser } from '../src/find-browser.ts';
import { socialText } from '../src/i18n/index.ts';
import { MODEL_TEXT, type ModelLanguage } from '../src/model-text.ts';
import { Ocr, OcrImageError } from '../src/ocr.ts';
import { ADAPTERS } from '../src/platforms/index.ts';
import { AUTO_NOTE, BOT_COMMENT_MAX } from '../src/platforms/reddit.ts';
import { noteDoc } from '../src/platforms/substack-parse.ts';
import { SUBSTACK_AUTO_NOTE } from '../src/platforms/substack.ts';
import { PLATFORM_IDS } from '../src/posts.ts';
import { COMMENT_TEXT_MAX, clock, localStamp } from '../src/render.ts';
import { SOCIAL_TOOL_DECLS } from '../src/tools.ts';
import {
  FIRST_WAIT_MS, GAPS, LATE_MIN, REPLIES_PER_ACCOUNT, REPLY_CHECK_MS, REPLY_MAX_AGE_MS, REPLY_WAIT_MS, SCHEDULE_MS, WRITE_FROM_MIN, WRITE_TO_MIN, SocialWorld, planTimes,
  type SocialPanelState, type SocialWorldOptions,
} from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { ScriptedBrowser, json, type PageScript } from './helpers/scripted-browser.ts';

const TZ = 'Asia/Singapore';
const t = MODEL_TEXT.en;
const HAN = /\p{Script=Han}/u;
const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** Core's `persist`: objects merge, leaves and arrays are replaced. */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) mergeInto(cur as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = structuredClone(v);
  }
}

/* ---------- fixtures ---------- */

type Routes = Record<string, (u: URL) => FetchedText | undefined>;
/** A script answering `fetchText` by origin and path. */
const site = (routes: Routes, extra: Partial<PageScript> = {}): PageScript => ({
  fetch: (url) => {
    const u = new URL(url);
    return routes[u.origin + u.pathname]?.(u);
  },
  ...extra,
});

const REDDIT = 'https://www.reddit.com';
const HOT = `${REDDIT}/r/fixture/hot.json`;

const redditPost = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 't3',
  data: {
    id, name: `t3_${id}`, title: `Fixture title ${id}`, selftext: `Fixture text ${id}`, author: 'fixture_author',
    subreddit_name_prefixed: 'r/fixture', score: 12, num_comments: 3, created_utc: 1792634400,
    permalink: `/r/fixture/comments/${id}/fixture_${id}/`, ...over,
  },
});
const listing = (children: unknown[], after: string | null = null) => ({ kind: 'Listing', data: { after, children } });
const postUrl = (id: string) => `${REDDIT}/r/fixture/comments/${id}/fixture_${id}/`;

/**
 * `/r/fixture/hot.json` serving `pages` of post ids, each page's `after` naming the next;
 * `onPage(i)` runs as page `i` is served and may answer instead.
 */
function hot(pages: string[][], opts: { posts?: Record<string, Record<string, unknown>>; onPage?: (i: number) => FetchedText | void } = {}) {
  return (u: URL): FetchedText => {
    const after = u.searchParams.get('after');
    const i = after ? pages.findIndex((p) => `t3_${p[p.length - 1]}` === after) + 1 : 0;
    const instead = opts.onPage?.(i);
    if (instead) return instead;
    const ids = pages[i] ?? [];
    return json(listing(ids.map((id) => redditPost(id, opts.posts?.[id])), i + 1 < pages.length ? `t3_${ids[ids.length - 1]}` : null));
  };
}

const thread = (id: string, over: Record<string, unknown> = {}) => () => json([
  listing([redditPost(id, over)]),
  listing([
    { kind: 't1', data: { author: 'fixture_reply', body: 'First reply', score: 5 } },
    { kind: 't1', data: { author: 'fixture_other', body: 'Second reply', score: 2 } },
  ]),
]);

const gallery = (...urls: string[]) => ({
  media_metadata: Object.fromEntries(urls.map((u, i) => [`m${i}`, { e: 'Image', s: { u } }])),
  gallery_data: { items: urls.map((_, i) => ({ media_id: `m${i}` })) },
});

const BILI_API = 'https://api.bilibili.com';
const BV = 'BV1Fx411c7Ab';
const BV2 = 'BV1Gy411c7Cd';
const SUBTITLES = 'https://subtitles.fixture.test/';

/** Bilibili's view, nav and player answers for any video, its subtitle lines from `raw`. */
function bilibili(lines = 40): { routes: Routes; raw: PageScript['raw'] } {
  return {
    routes: {
      [`${BILI_API}/x/web-interface/view`]: (u) => json({ code: 0, data: { bvid: u.searchParams.get('bvid'), aid: 1, cid: 100, title: `Fixture lecture ${u.searchParams.get('bvid')}`, owner: { name: 'Fixture Uploader' }, duration: lines * 10 } }),
      [`${BILI_API}/x/web-interface/nav`]: () => json({ code: -101, data: { wbi_img: { img_url: `https://fixture.test/wbi/${'7'.repeat(32)}.png`, sub_url: `https://fixture.test/wbi/${'4'.repeat(32)}.png` } } }),
      [`${BILI_API}/x/player/wbi/v2`]: (u) => json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'en', lan_doc: 'English', subtitle_url: `${SUBTITLES}${u.searchParams.get('bvid')}.json` }] }, need_login_subtitle: false } }),
    },
    raw: (url) => (url.startsWith(SUBTITLES)
      ? { bytes: new TextEncoder().encode(JSON.stringify({ body: Array.from({ length: lines }, (_, i) => ({ from: i * 10, to: i * 10 + 9, content: `Line ${i} of the fixture lecture` })) })), mime: 'application/json' }
      : null),
  };
}

/** A subreddit, a thread and Bilibili's subtitles on one scripted browser, each call taking 1 s. */
function everything(): PageScript {
  const b = bilibili();
  return site({
    [HOT]: hot([['a', 'b', 'c', 'd', 'e', 'f', 'g']]),
    [`${REDDIT}/r/fixture/comments/r1/fixture_r1.json`]: thread('r1'),
    ...b.routes,
  }, { raw: b.raw, costMs: 1000 });
}

/* ---------- the World ---------- */

interface Made {
  world: SocialWorld;
  host: FakeHost;
  cfg: SocialConfigSection;
  browser: ScriptedBrowser;
  dataDir: string;
  persisted: unknown[];
  call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
  panel(method: string, ...args: unknown[]): Promise<SocialPanelState>;
}

async function makeWorld(script: PageScript = {}, patch: (c: SocialConfigSection) => void = () => {}, extra: Partial<SocialWorldOptions> & { dataDir?: string } = {}): Promise<Made> {
  const cfg = structuredClone(SOCIAL_DEFAULTS);
  cfg.enabled = true;
  // the limits the cases below count against
  cfg.maxPosts = 5;
  cfg.maxSec = 120;
  patch(cfg);
  const browser = new ScriptedBrowser(script);
  const dataDir = extra.dataDir ?? mkdtempSync(join(tmpdir(), 'social-world-'));
  if (!extra.dataDir) cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const persisted: unknown[] = [];
  const world = new SocialWorld({
    cfg, timezone: TZ, dataDir, ocrDir: join(dataDir, 'ocr'),
    persist: (p) => { persisted.push(structuredClone(p)); mergeInto(cfg as unknown as Record<string, unknown>, p as Record<string, unknown>); },
    modelLanguage: () => 'en', language: () => 'en', browser, now: browser.clock.read,
    ocr: new Ocr({ dataDir: join(dataDir, 'ocr'), fetch: async () => { throw new Error('no network in tests'); } }),
    ...extra,
  });
  const host = new FakeHost();
  await world.start(host);
  cleanup.push(() => world.stop());
  const tools = new Map(world.tools().map((d) => [d.name, d]));
  return {
    world, host, cfg, browser, dataDir, persisted,
    call: async (name, args = {}, signal) => {
      const r = await tools.get(name)!.handler(args, { role: 'main', log: host.log, signal });
      return typeof r === 'string' ? { text: r } : r;
    },
    panel: async (method, ...args) => await world.webUi('en').invoke!('social', method, args) as SocialPanelState,
  };
}

const used = (posts: number, maxPosts: number, sec: number, maxSec: number) => t.used({ posts, maxPosts, sec, maxSec });

/** Moves the World's clock by `ms`, then lets its schedule look, which sends a queued post whose time came; needs fake timers. */
async function waitFor(made: Made, ms: number): Promise<void> {
  made.browser.clock.now += ms;
  await vi.advanceTimersByTimeAsync(SCHEDULE_MS);
}

describe('mounting', () => {
  it('passes the dry mount with no failures or warnings', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'social-dry-'));
    cleanup.push(() => rmSync(scratchDir, { recursive: true, force: true }));
    const report = await dryMountWorld(SOCIAL as never, { scratchDir, packageDir: fileURLToPath(new URL('../', import.meta.url)), hasWebUiClient: true });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('binds every declared tool under its declared name, each interruptible', async () => {
    const { world } = await makeWorld();
    const tools = world.tools();
    expect(tools.map((d) => d.name)).toEqual(SOCIAL_TOOL_DECLS.map((d) => d.name));
    for (const [i, tool] of tools.entries()) {
      const { handler, interruptible, ...decl } = tool;
      expect(decl).toEqual(SOCIAL_TOOL_DECLS[i]);
      expect(interruptible, tool.name).toBe(true);
      expect(typeof handler).toBe('function');
    }
  });

  it('declares only config keys that exist in the defaults', async () => {
    const { world } = await makeWorld();
    const groups = world.webUi('en').config ?? [];
    expect(groups.map((g) => g.id)).toEqual(['world:social']);
    const keys = Object.keys(groups[0]!.schema.properties ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith('worlds.social.'), key).toBe(true);
      expect(getByPath(SOCIAL_DEFAULTS as unknown as Record<string, unknown>, key.slice('worlds.social.'.length)), key).not.toBeUndefined();
    }
  });
});

describe('per-request limits', () => {
  it('adds up the posts and seconds of social_browse, social_read and social_transcript in one turn', async () => {
    const { call } = await makeWorld(everything());
    const first = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 2 });
    expect(first.text).toContain(t.browseHead('Reddit', t.source('community', 'fixture', 'hot'), t.posts(2, false), t.duration(2000)));
    expect(first.text).toContain(used(2, 5, 2, 120));
    expect((await call('social_read', { url: postUrl('r1') })).text).toContain(used(3, 5, 4, 120));
    expect((await call('social_transcript', { video: BV })).text).toContain(used(4, 5, 9, 120));
    // the rest of the request's posts, whatever the listing holds
    const last = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(last.text).toContain(t.posts(1, false));
    expect(last.text).toContain(used(5, 5, 11, 120));
  });

  it('refuses a read once the posts are used up, naming the limits; a later part of a counted video is still served', async () => {
    const { call, browser } = await makeWorld(everything(), (c) => { c.maxPosts = 2; c.maxTranscriptChars = 300; });
    await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 1 });
    const part = await call('social_transcript', { video: BV });
    const next = Number(/from_sec (\d+)/.exec(part.text)?.[1]);
    const limitUsed = t.limitUsed({ posts: 2, maxPosts: 2, sec: 7, maxSec: 120 });
    expect((await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' })).text).toBe(t.notRun('social_browse', limitUsed));
    expect((await call('social_read', { url: postUrl('r1') })).text).toBe(t.notRun('social_read', limitUsed));
    expect((await call('social_transcript', { video: BV2 })).text).toBe(t.notRun('social_transcript', limitUsed));
    const requests = browser.requests.length;
    const more = await call('social_transcript', { video: BV, from_sec: next });
    expect(more.text).toContain(`[${clock(next)}] Line`);
    expect(more.text).toContain(used(2, 2, 7, 120));
    expect(browser.requests.length).toBe(requests);
  });

  it('stops a listing at the time limit and refuses the next read', async () => {
    const { call, browser } = await makeWorld(site({ [HOT]: hot([['a', 'b'], ['c', 'd'], ['e', 'f']]) }, { costMs: 4000 }), (c) => { c.maxSec = 10; });
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    // robots.txt and the first page take 8 s; the second page runs into the deadline at 10 s
    expect(r.text).toContain(t.posts(2, false));
    expect(r.text).toContain(t.stopped.time);
    expect(r.text).toContain(used(2, 5, 10, 10));
    expect(browser.requests.filter((u) => u.includes('after=t3_d'))).toEqual([]);
    expect((await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' })).text)
      .toBe(t.notRun('social_browse', t.limitUsed({ posts: 2, maxPosts: 5, sec: 10, maxSec: 10 })));
  });

  it('starts a new request when the turn ends', async () => {
    const { world, call } = await makeWorld(everything(), (c) => { c.maxPosts = 2; });
    await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect((await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' })).text).toMatch(/^\[social_browse not run\]/);
    world.onTurnEnded();
    const again = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 1 });
    expect(again.text).toContain(used(1, 2, 2, 120));
  });

  it('reports the time a transcript spent when it runs out of time', async () => {
    const b = bilibili();
    const { call } = await makeWorld(site(b.routes, { raw: b.raw, costMs: 6000 }), (c) => { c.maxSec = 10; });
    // the page and the details take 6 s each; the second runs into the deadline at 10 s
    expect((await call('social_transcript', { video: BV })).text)
      .toBe(t.notRun('social_transcript', t.limitUsed({ posts: 0, maxPosts: 5, sec: 10, maxSec: 10 })));
  });
});

describe('transcripts', () => {
  it('counts a video once per request and serves from_sec from the transcript already read', async () => {
    const { world, call, browser } = await makeWorld(everything(), (c) => { c.maxTranscriptChars = 300; });
    const first = await call('social_transcript', { video: `https://www.bilibili.com/video/${BV}/` });
    expect(first.text).toContain('[0:00] Line 0 of the fixture lecture');
    expect(first.text).toContain(used(1, 5, 5, 120));
    const next = Number(/from_sec (\d+)/.exec(first.text)?.[1]);
    expect(next).toBeGreaterThan(0);
    const fetched = browser.requests.length;

    const second = await call('social_transcript', { video: BV, from_sec: next });
    expect(second.text).toContain(`[${clock(next)}] Line ${next / 10} of`);
    expect(second.text).not.toContain('[0:00]');
    expect(second.text).toContain(used(1, 5, 5, 120));
    expect(browser.requests.length).toBe(fetched);

    // the next request reads it from the cache and counts it once again
    world.onTurnEnded();
    const later = await call('social_transcript', { video: BV, from_sec: next });
    expect(later.text).toContain(used(1, 5, 0, 120));
    expect(browser.requests.length).toBe(fetched);
  });

  it('counts each different video as one post', async () => {
    const { call } = await makeWorld(everything());
    await call('social_transcript', { video: BV });
    expect((await call('social_transcript', { video: BV2 })).text).toContain(used(2, 5, 10, 120));
  });

  it('says why a video has no transcript', async () => {
    const b = bilibili();
    const routes = { ...b.routes, [`${BILI_API}/x/player/wbi/v2`]: () => json({ code: 0, data: { subtitle: { subtitles: [] }, need_login_subtitle: true } }) };
    const { call } = await makeWorld(site(routes, { raw: b.raw }));
    expect((await call('social_transcript', { video: BV })).text).toBe(t.notRun('social_transcript', t.noTranscript('login', `Fixture lecture ${BV}`)));
  });
});

describe('refusals', () => {
  it('refuses a platform turned off before opening a page', async () => {
    const { call, browser } = await makeWorld(everything(), (c) => { c.platforms.reddit.enabled = false; c.platforms.bilibili.enabled = false; });
    expect((await call('social_browse', { platform: 'reddit', source: 'feed' })).text).toBe(t.notRun('social_browse', t.platformOff('Reddit')));
    expect((await call('social_read', { url: postUrl('r1') })).text).toBe(t.notRun('social_read', t.platformOff('Reddit')));
    expect((await call('social_transcript', { video: BV })).text).toBe(t.notRun('social_transcript', t.platformOff('Bilibili')));
    expect(browser.requests).toEqual([]);
  });

  it('refuses a source the platform lacks, a listing without a query, an unknown platform, a link elsewhere and a non-video', async () => {
    const { call, browser } = await makeWorld(everything());
    expect((await call('social_browse', { platform: 'threads', source: 'community', query: 'fixture' })).text)
      .toBe(t.notRun('social_browse', t.noSource('Threads', 'community', [...ADAPTERS.threads.sources])));
    expect((await call('social_browse', { platform: 'reddit', source: 'search' })).text).toBe(t.notRun('social_browse', t.needQuery));
    expect((await call('social_browse', { platform: 'fixturebook', source: 'feed' })).text).toBe(t.notRun('social_browse', t.error('unknown platform fixturebook')));
    expect((await call('social_read', { url: 'https://fixture.test/posts/1' })).text).toBe(t.notRun('social_read', t.notPlatformUrl));
    expect((await call('social_transcript', { video: postUrl('r1') })).text).toBe(t.notRun('social_transcript', t.notVideo));
    expect(browser.requests).toEqual([]);
  });

  it('fails with the reason when the browser set on the page is not there', async () => {
    const missing = join(tmpdir(), 'no-such-browser');
    const { call } = await makeWorld({}, (c) => { c.browserFile = missing; }, { browser: undefined });
    expect(await call('social_browse', { platform: 'reddit', source: 'feed' })).toEqual({ text: t.failed('social_browse', t.noBrowserAt(missing)), failed: true });
  });

  it('gives only the first line of an error, without terminal colors', async () => {
    const { call } = await makeWorld({ fetch: () => { throw new Error('\u001b[31mfetch: net::ERR_FIXTURE\u001b[39m\nCall log:\n  - fixture'); } });
    expect(await call('social_browse', { platform: 'reddit', source: 'feed' })).toEqual({ text: t.failed('social_browse', t.error('fetch: net::ERR_FIXTURE')), failed: true });
  });
});

describe('blocks and interruptions', () => {
  it('fails naming social_login when the platform asks for a login before any post', async () => {
    const { call, world } = await makeWorld(site({ [`${REDDIT}/.json`]: () => ({ status: 401, text: '' }) }, { costMs: 1000 }));
    const r = await call('social_browse', { platform: 'reddit', source: 'feed' });
    expect(r).toEqual({ text: t.failed('social_browse', t.blocked('Reddit', 'reddit', 'login', 'HTTP 401')), failed: true });
    expect(r.text).toContain('social_login');
    // the time spent still counts
    expect((await world.webUi('en').invoke!('social', 'state', []) as SocialPanelState).lifetime.platforms.reddit.ms).toBe(2000);
  });

  it('returns the posts read before a block, with the block', async () => {
    const { call } = await makeWorld(site({ [HOT]: hot([['a', 'b'], ['c']], { onPage: (i) => (i === 1 ? { status: 401, text: '' } : undefined) }) }));
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain(t.posts(2, false));
    expect(r.text).toContain(postUrl('a'));
    expect(r.text).toContain(postUrl('b'));
    expect(r.text).toContain(t.blocked('Reddit', 'reddit', 'login', 'HTTP 401'));
    expect(r.text).not.toContain(t.stopped.end);
  });

  it('returns the posts read before an error, with the error', async () => {
    const { call } = await makeWorld(site({ [HOT]: hot([['a', 'b'], ['c']], { onPage: (i) => { if (i === 1) throw new Error('TypeError: Failed to fetch'); } }) }));
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(r.failed).toBeUndefined();
    expect(r.text).toContain(t.posts(2, false));
    expect(r.text).toContain(postUrl('b'));
    expect(r.text).toContain(t.error('TypeError: Failed to fetch'));
    expect(r.text).toContain(used(2, 5, 0, 120));
  });

  it('returns what was read when interrupted, without asking for more', async () => {
    const stop = new AbortController();
    const { call, browser } = await makeWorld(site({ [HOT]: hot([['a', 'b'], ['c', 'd'], ['e', 'f']], { onPage: (i) => { if (i === 1) stop.abort(); } }) }));
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' }, stop.signal);
    expect(r.text).toContain(t.posts(4, false));
    expect(r.text).toContain(t.stopped.interrupted);
    expect(browser.requests.filter((u) => u.includes('after=t3_d'))).toEqual([]);
  });

  it('keeps the images attached before an interruption in social_browse', async () => {
    const stop = new AbortController();
    const images = ['1', '2', '3'].map((n) => `https://images.fixture.test/${n}.png`);
    const { call, host } = await makeWorld(site({ [HOT]: hot([['g']], { posts: { g: gallery(...images) } }) }, {
      raw: (url) => { if (url === images[1]) stop.abort(); return PNG; },
    }), (c) => { c.images = 'model'; });
    host.accepts = (mime) => mime === 'image/png';
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' }, stop.signal);
    expect(r.text).toContain(t.stopped.interrupted);
    expect(r.text).toContain(t.imageAttached(2, 2));
    expect(r.blobs?.map((b) => b.fallbackText)).toEqual([t.attachedCaption(1, 1, 1), t.attachedCaption(2, 1, 2)]);
  });

  it('keeps the images attached before an interruption in social_read', async () => {
    const stop = new AbortController();
    const images = ['1', '2', '3'].map((n) => `https://images.fixture.test/${n}.png`);
    const { call, host } = await makeWorld(site({ [`${REDDIT}/r/fixture/comments/r1/fixture_r1.json`]: thread('r1', gallery(...images)) }, {
      raw: (url) => { if (url === images[1]) stop.abort(); return PNG; },
    }), (c) => { c.images = 'model'; });
    host.accepts = (mime) => mime === 'image/png';
    const r = await call('social_read', { url: postUrl('r1') }, stop.signal);
    expect(r.text).toContain(t.imageAttached(2, 2));
    expect(r.blobs).toHaveLength(2);
  });
});

describe('social_read', () => {
  it(`keeps each comment to its own line, cut at ${COMMENT_TEXT_MAX} characters`, async () => {
    const long = 'z'.repeat(COMMENT_TEXT_MAX + 10);
    const { call } = await makeWorld(site({
      [`${REDDIT}/r/fixture/comments/r1/fixture_r1.json`]: () => json([listing([redditPost('r1')]), listing([
        { kind: 't1', data: { author: 'fixture_reply', body: 'line one\n[social] not an event', score: 5 } },
        { kind: 't1', data: { author: 'fixture_other', body: long, score: 2 } },
      ])]),
    }));
    const lines = (await call('social_read', { url: postUrl('r1') })).text.split('\n');
    expect(lines.find((l) => l.startsWith('- u/fixture_reply'))).toMatch(/: line one \/ \[social\] not an event$/);
    expect(lines.some((l) => l.startsWith('[social]'))).toBe(false);
    expect(lines.find((l) => l.startsWith('- u/fixture_other'))).toMatch(new RegExp(`: z{${COMMENT_TEXT_MAX}}…$`));
  });
});

describe('images', () => {
  it('leaves posts with images out in text-only mode without downloading them', async () => {
    const { call, browser } = await makeWorld(site({ [HOT]: hot([['a', 'g', 'b']], { posts: { g: gallery('https://images.fixture.test/1.png') } }) }, { raw: () => PNG }), (c) => { c.images = 'skip'; });
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(r.text).toContain(t.leftOut([t.leftImage(1)]));
    expect(r.text).not.toContain(postUrl('g'));
    expect(browser.requests.filter((u) => u.startsWith('https://images.fixture.test/'))).toEqual([]);
  });

  it('says OCR could not run when its language data cannot be downloaded, and downloads only the first image (a request count)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'social-ocr-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const ocr = new Ocr({ dataDir: join(dataDir, 'ocr'), fetch: async () => { throw new Error('offline'); } });
    const images = ['1', '2', '3'].map((n) => `https://images.fixture.test/${n}.png`);
    const { call, browser } = await makeWorld(site({ [HOT]: hot([['g']], { posts: { g: gallery(...images) } }) }, { raw: () => PNG }), () => {}, { ocr });
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(r.text).toMatch(/OCR could not run \(OCR data for eng could not be downloaded \(.*offline/);
    for (const n of [1, 2, 3]) expect(r.text).toContain(t.imageUnread(n, 'ocr'));
    expect(browser.requests.filter((u) => images.includes(u))).toEqual([images[0]]);
  });

  it('leaves out only an image OCR cannot decode and reads the next one', async () => {
    const JUNK = new Uint8Array([1, 2, 3]);
    class FixtureOcr extends Ocr {
      override async read(image: Uint8Array): Promise<string> {
        if (image === JUNK) throw new OcrImageError('Error attempting to read image.');
        return 'fixture words';
      }
    }
    const ocr = new FixtureOcr({ dataDir: join(tmpdir(), 'unused'), fetch: async () => { throw new Error('no network in tests'); } });
    const images = ['1', '2', '3'].map((n) => `https://images.fixture.test/${n}.png`);
    const raw = (u: string) => (u === images[1] ? { bytes: JUNK, mime: 'image/png' } : PNG);
    const { call } = await makeWorld(site({ [HOT]: hot([['g']], { posts: { g: gallery(...images) } }) }, { raw }), () => {}, { ocr });
    const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture' });
    expect(r.text).toContain(t.imageOcr(1, 'fixture words'));
    expect(r.text).toContain(t.imageUnread(2, 'decode'));
    expect(r.text).toContain(t.imageOcr(3, 'fixture words'));
    expect(r.text).not.toContain('OCR could not run');
  });
});

describe('lifetime counter', () => {
  it('adds each read to its platform and keeps the count across restarts', async () => {
    const { call, panel, world, dataDir } = await makeWorld(everything());
    await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 3 });
    await call('social_transcript', { video: BV });
    const life = (await panel('state')).lifetime;
    expect(life.platforms.reddit).toMatchObject({ ms: 2000, posts: 3, transcripts: 0 });
    expect(life.platforms.bilibili).toMatchObject({ ms: 5000, posts: 1, transcripts: 1 });
    expect(life.platforms.x).toEqual({ ms: 0, posts: 0, transcripts: 0 });

    const stats = (await call('social_stats')).text;
    const last = (p: 'reddit' | 'bilibili') => localStamp(life.platforms[p].lastAt!, TZ);
    expect(stats).toContain(t.statsHead(localStamp(life.sinceAt, TZ)));
    expect(stats).toContain(t.statsLine('Reddit', t.duration(2000), 3, 0, last('reddit')));
    expect(stats).toContain(t.statsLine('Bilibili', t.duration(5000), 1, 1, last('bilibili')));
    expect(stats).not.toContain('- X:');
    expect(stats).toContain(t.statsJobs([]));

    await world.stop();
    const again = await makeWorld({}, () => {}, { dataDir });
    expect((await again.panel('state')).lifetime).toEqual(life);
  });

  it('says nothing was read yet, and which platforms are logged in once checked', async () => {
    const { call, panel, browser } = await makeWorld();
    browser.cookies = { '.reddit.com': ['reddit_session'], '.bilibili.com': ['buvid3'] };
    expect((await call('social_stats')).text).toContain(t.statsNone);
    const state = await panel('checkLogins');
    expect(state.logins).toEqual(Object.fromEntries(PLATFORM_IDS.map((p) => [p, p === 'reddit'])));
    const others = PLATFORM_IDS.filter((p) => p !== 'reddit').map((p) => t.platform[p]);
    expect((await call('social_stats')).text).toContain(t.statsLogins(['Reddit'], others));
  });

  it('starts again from now when reset from the panel', async () => {
    const { call, panel, browser } = await makeWorld(everything());
    await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 1 });
    browser.clock.now += 60_000;
    const { lifetime } = await panel('resetLifetime');
    expect(lifetime.sinceAt).toBe(new Date(browser.clock.now).toISOString());
    for (const p of PLATFORM_IDS) expect(lifetime.platforms[p]).toEqual({ ms: 0, posts: 0, transcripts: 0 });
  });
});

describe('logins', () => {
  it('opens the platform login page and tells the bot whether a login holds once the window closes', async () => {
    const { call, host, browser } = await makeWorld();
    expect((await call('social_login', { platform: 'x' })).text).toBe(t.loginOpened('X'));
    expect(browser.logins.map((l) => l.url)).toEqual([ADAPTERS.x.loginUrl]);
    browser.cookies = { '.x.com': ['auth_token'] };
    browser.logins[0]!.close();
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'social.login', origin: 'internal', text: t.loginEvent('X', true) });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
  });

  it('checks the logins of the platforms turned on only', async () => {
    const { panel, browser } = await makeWorld({}, (c) => { c.platforms.x.enabled = false; });
    browser.cookies = { '.x.com': ['auth_token'], '.reddit.com': ['reddit_session'] };
    const { logins } = await panel('checkLogins');
    expect(logins.x).toBeUndefined();
    expect(logins.reddit).toBe(true);
  });

  it('sends the login event from a panel login with the next batch', async () => {
    const { panel, host, browser } = await makeWorld();
    await panel('login', 'reddit');
    browser.logins[0]!.close();
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]!.text).toBe(t.loginEvent('Reddit', false));
    expect(host.pushOpts[0]).toEqual({ trigger: 'piggyback' });
  });
});

describe('panel and daily autoscroll', () => {
  const JOB: AutoscrollJob = { platform: 'reddit', source: 'community', query: 'fixture', maxPosts: 3, at: '07:00', images: 'skip' };

  it('reports the settings, jobs, browser, lifetime, digests and caps', async () => {
    const { panel, cfg } = await makeWorld();
    const state = await panel('state');
    expect(state).toEqual({
      config: {
        maxPosts: cfg.maxPosts, maxSec: cfg.maxSec, images: cfg.images, maxTranscriptChars: cfg.maxTranscriptChars, showBrowser: cfg.showBrowser, browserFile: cfg.browserFile,
        platforms: Object.fromEntries(PLATFORM_IDS.map((p) => [p, true])),
        autoscroll: { enabled: cfg.autoscroll.enabled, maxMinutes: cfg.autoscroll.maxMinutes },
        comments: { enabled: cfg.comments.enabled, maxPerDay: cfg.comments.maxPerDay, auto: cfg.comments.auto, autoReply: cfg.comments.autoReply, sign: cfg.comments.sign },
        substack: cfg.substack,
      },
      jobs: [],
      browser: findBrowser(cfg.browserFile),
      logins: {},
      checkingLogins: false,
      lifetime: expect.objectContaining({ sinceAt: expect.any(String) }),
      digests: [],
      running: null,
      comments: { drafts: [], posted: [], postedNotes: [], today: 0, posting: [], checkedAt: null, queued: [], notesToday: 0 },
      caps: {
        maxPosts: MAX_POSTS_CAP, maxSec: MAX_SEC_CAP, jobPosts: JOB_POSTS_CAP, jobs: MAX_JOBS, commentsPerDay: COMMENTS_PER_DAY_CAP,
        replyCheckMin: REPLY_CHECK_MS / 60_000, repliesPerAccount: REPLIES_PER_ACCOUNT,
        notesPerDay: NOTES_PER_DAY_CAP, dailyNotes: DAILY_NOTES_CAP, commentGapMin: GAPS.comment / 60_000, noteGapMin: GAPS.note / 60_000,
        writeFromMin: WRITE_FROM_MIN, writeToMin: WRITE_TO_MIN,
      },
    });
  });

  it('persists the job list as parseJobs reads it, leaving the other autoscroll settings', async () => {
    const { panel, persisted, cfg } = await makeWorld();
    const raw = [JOB, { ...JOB, at: '25:00' }, { ...JOB, platform: 'fixturebook' }, { ...JOB, query: 'other', maxPosts: 9999 }];
    const state = await panel('setJobs', raw);
    expect(persisted).toEqual([{ autoscroll: { jobs: parseJobs(raw) } }]);
    expect(state.jobs).toEqual(parseJobs(raw));
    expect(cfg.autoscroll).toMatchObject({ enabled: SOCIAL_DEFAULTS.autoscroll.enabled, maxMinutes: SOCIAL_DEFAULTS.autoscroll.maxMinutes });
    await expect(panel('runNow', 'no|such|job|00:00')).rejects.toThrow();
    await expect(panel('noSuchMethod')).rejects.toThrow();
  });

  it('runs a job now and holds its digest event until the bot is idle', async () => {
    const { world, panel, host, call, browser } = await makeWorld(everything(), (c) => { c.autoscroll.enabled = true; });
    await panel('setJobs', [JOB]);
    world.onRunPhase({ state: 'model', running: [], enteredAt: new Date().toISOString() });
    const startedAt = browser.clock.now;
    const started = await panel('runNow', jobKey(JOB));
    expect(started.running).toBe(jobKey(JOB));
    await expect.poll(async () => (await panel('state')).digests.length).toBe(1);
    const id = digestId(localClock(startedAt, TZ).date, JOB);
    expect((await panel('state')).running).toBeNull();
    expect(host.events).toEqual([]);

    world.onRunPhase({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]).toMatchObject({
      type: 'social.digest',
      source: 'social',
      text: t.digestEvent('Reddit, community fixture', t.posts(3, false), t.duration(2000), `${t.stopped.count} `, id),
    });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });

    // the digest is read with social_digest, and the run counts towards the lifetime counter
    const page = (await call('social_digest', { id })).text;
    expect(page.split('\n')[0]).toBe(t.digestHead('Reddit, community fixture', localStamp(new Date(startedAt).toISOString(), TZ), 3, 1, 3));
    for (const p of ['a', 'b', 'c']) expect(page).toContain(postUrl(p));
    expect((await call('social_digest')).text).toBe(t.digestList([t.digestListLine(id, 'Reddit, community fixture', 3)]));
    expect((await call('social_digest', { id: 'no-such-digest' })).text).toBe(t.notRun('social_digest', t.digestMissing));
    expect((await panel('state')).lifetime.platforms.reddit.posts).toBe(3);
    expect((await call('social_stats')).text).toContain(t.statsJobs([t.jobLine('07:00', 'Reddit', t.source('community', 'fixture'), 3, true)]));
  });

  it('pushes a digest event at once when the bot is already idle, and a failed run says why', async () => {
    const { panel, host } = await makeWorld(site({ [HOT]: () => ({ status: 401, text: '' }) }));
    await panel('setJobs', [JOB]);
    await panel('runNow', jobKey(JOB));
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]!.text).toBe(t.digestFailed('Reddit, community fixture', t.blocked('Reddit', 'reddit', 'login', 'HTTP 401')));
  });

  it('says in the digest event that a block ended the run after some posts', async () => {
    const { panel, host } = await makeWorld(site({ [HOT]: hot([['a', 'b'], ['c']], { onPage: (i) => (i === 1 ? { status: 401, text: '' } : undefined) }) }));
    await panel('setJobs', [{ ...JOB, maxPosts: 5 }]);
    await panel('runNow', jobKey({ ...JOB, maxPosts: 5 }));
    await expect.poll(() => host.events.length).toBe(1);
    expect(host.events[0]!.text).toContain(t.posts(2, false));
    expect(host.events[0]!.text).toContain(t.blocked('Reddit', 'reddit', 'login', 'HTTP 401'));
    expect(host.events[0]!.text).not.toContain(t.stopped.end);
  });

  it('reads the images of a job set to show them to the model with OCR, since a digest is read as text', async () => {
    const images = ['https://images.fixture.test/1.png'];
    const { panel, host, call } = await makeWorld(site({ [HOT]: hot([['g']], { posts: { g: gallery(...images) } }) }, { raw: () => PNG }));
    host.accepts = (mime) => mime === 'image/png';
    const job: AutoscrollJob = { ...JOB, images: 'ocr' };
    // a list written before job images were narrowed, or by hand: parseJobs reads 'model' as OCR
    await panel('setJobs', [{ ...job, images: 'model' }]);
    await panel('runNow', jobKey(job));
    await expect.poll(() => host.events.length).toBe(1);
    const page = (await call('social_digest', { id: (await panel('state')).digests[0]!.id })).text;
    expect(page).toContain(t.imageUnread(1, 'ocr'));
    expect(page).not.toContain(t.imageAttached(1, 1));
  });

  it('refuses to run a job while a login window is open', async () => {
    const { panel, browser } = await makeWorld(everything());
    await panel('setJobs', [JOB]);
    await panel('login', 'reddit');
    await expect(panel('runNow', jobKey(JOB))).rejects.toThrow(socialText('en').panel.loginOpen);
    browser.logins[0]!.close();
    expect((await panel('runNow', jobKey(JOB))).running).toBe(jobKey(JOB));
  });

  it('neither saves nor tells a run that stopping the World cut off, and leaves the job due', async () => {
    let fail: (err: Error) => void = () => {};
    const hanging = new Promise<never>((_, reject) => { fail = reject; });
    const { world, panel, host, dataDir } = await makeWorld({ fetch: (url) => (url.includes('/hot.json') ? hanging : undefined) });
    await panel('setJobs', [JOB]);
    await panel('runNow', jobKey(JOB));
    await world.stop();
    fail(new Error('Target page, context or browser has been closed'));
    await expect.poll(async () => (await panel('state')).running).toBeNull();
    expect((await panel('state')).digests).toEqual([]);
    expect(host.events).toEqual([]);
    expect(new DigestStore(join(dataDir, 'social-digests')).lastRuns()).toEqual({});
  });

  it('says when no digest was saved yet', async () => {
    const { call } = await makeWorld();
    expect((await call('social_digest')).text).toBe(t.notRun('social_digest', t.digestNone));
  });
});

describe('environment prompt', () => {
  it('fills every placeholder from the config', async () => {
    const { world, cfg } = await makeWorld({}, (c) => { c.platforms.instagram.enabled = false; c.maxPosts = 7; c.images = 'skip'; });
    const vars = await world.envPromptVars();
    expect(vars).toEqual({
      'social.platforms': t.envPlatforms(PLATFORM_IDS.filter((p) => p !== 'instagram').map((p) => t.platform[p])),
      'social.maxPosts': '7',
      'social.maxSec': String(cfg.maxSec),
      'social.images': t.envImages.skip,
      'social.autoscroll': t.envAutoscroll([]),
      'social.comments': t.envComments(cfg.comments),
      'social.substack': t.envSubstack({ ...cfg.substack, publication: null }),
    });
    const doc = world.webUi('en').promptDocs![0]!;
    expect(doc.vars?.map((v) => v.name).sort()).toEqual(Object.keys(vars).sort());
    const prompt = renderTemplate(readFileSync(doc.path, 'utf8'), vars);
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).not.toMatch(HAN);
  });

  it('lists the autoscroll jobs once autoscroll is on', async () => {
    const { world, panel, cfg } = await makeWorld();
    await panel('setJobs', [{ platform: 'youtube', source: 'search', query: 'fixture news', maxPosts: 10, at: '08:30', images: 'ocr' }]);
    expect((await world.envPromptVars())['social.autoscroll']).toBe(t.envAutoscroll([]));
    cfg.autoscroll.enabled = true;
    expect((await world.envPromptVars())['social.autoscroll']).toBe(t.envAutoscroll([t.jobLine('08:30', 'YouTube', t.source('search', 'fixture news'), 10, false)]));
  });

  it('names the publication post drafts go to, read from what the person entered', async () => {
    const { world, cfg } = await makeWorld({}, (c) => { c.substack.publication = ' fixturewriter '; });
    expect((await world.envPromptVars())['social.substack']).toBe(t.envSubstack({ ...cfg.substack, publication: 'https://fixturewriter.substack.com' }));
  });

  it('says whether comment drafts are on, with the daily limit', async () => {
    const { world, cfg } = await makeWorld({}, (c) => { c.comments.maxPerDay = 4; });
    expect((await world.envPromptVars())['social.comments']).toBe(t.envComments({ ...cfg.comments, enabled: false, maxPerDay: 4 }));
    cfg.comments.enabled = true;
    expect((await world.envPromptVars())['social.comments']).toBe(t.envComments({ ...cfg.comments, enabled: true, maxPerDay: 4 }));
  });
});

describe('model language', () => {
  it('gives English receipts and events no Chinese of their own', async () => {
    const { world, call, panel, host, browser } = await makeWorld(everything(), (c) => { c.maxTranscriptChars = 300; c.autoscroll.enabled = true; });
    const texts = [
      (await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixture', max_posts: 2 })).text,
      (await call('social_read', { url: postUrl('r1') })).text,
      (await call('social_transcript', { video: BV })).text,
      (await call('social_stats')).text,
      (await call('social_digest')).text,
      (await call('social_login', { platform: 'bilibili' })).text,
      (await call('social_browse', { platform: 'threads', source: 'community', query: 'x' })).text,
      (await call('social_browse', { platform: 'rednote', source: 'search' })).text,
    ];
    world.onTurnEnded();
    browser.logins[0]!.close();
    await expect.poll(() => host.events.length).toBe(1);
    const job: AutoscrollJob = { platform: 'reddit', source: 'community', query: 'fixture', maxPosts: 2, at: '00:00', images: 'skip' };
    await panel('setJobs', [job]);
    await panel('runNow', jobKey(job));
    await expect.poll(() => host.events.length).toBe(2);
    texts.push(...host.events.map((e) => e.text), ...Object.values(await world.envPromptVars() ?? {}));
    for (const text of texts) expect(text).not.toMatch(HAN);
  });

  it('follows the model language at each call', async () => {
    let language: ModelLanguage = 'en';
    const { call } = await makeWorld({}, () => {}, { modelLanguage: () => language });
    expect((await call('social_browse', { platform: 'reddit', source: 'search' })).text).toBe(t.notRun('social_browse', t.needQuery));
    language = 'zh';
    expect((await call('social_browse', { platform: 'reddit', source: 'search' })).text).toBe(MODEL_TEXT.zh.notRun('social_browse', MODEL_TEXT.zh.needQuery));
  });
});

describe('comments', () => {
  const POST = postUrl('r1');
  const ME = `${REDDIT}/api/me.json`;
  const COMMENT = `${REDDIT}/api/comment`;
  const c = socialText('en').comments;
  const linkOf = (n: number) => `${REDDIT}/r/fixture/comments/r1/fixture_r1/k${n}/`;
  /** Reddit with a login: keeps the text of each comment posted and answers the nth as `answer(n)` says. */
  const commenting = (answer = (n: number): FetchedText => json({ json: { errors: [], data: { things: [{ kind: 't1', data: { id: `k${n}`, link_id: 't3_r1', permalink: `/r/fixture/comments/r1/fixture_r1/k${n}/` } }] } } })) => {
    const sent: string[] = [];
    const script: PageScript = {
      fetch: (url, init) => {
        if (url === ME) return json({ kind: 't2', data: { name: 'fixture_alice', modhash: 'fixturehash' } });
        if (url !== COMMENT) return undefined;
        sent.push(new URLSearchParams(init?.body).get('text') ?? '');
        return answer(sent.length);
      },
    };
    return { script, sent };
  };
  const on = (cfg: SocialConfigSection) => { cfg.comments.enabled = true; };
  const draftIds = async (made: Made) => (await made.panel('state')).comments.drafts.map((d) => d.id);

  it('drafts nothing while drafting is off', async () => {
    const made = await makeWorld();
    expect((await made.call('social_comment', { url: POST, text: 'Worth the wait.' })).text).toBe(t.notRun('social_comment', t.commentsOff));
    expect(await draftIds(made)).toEqual([]);
  });

  it('keeps a draft for the person and brings up the panel once, posting nothing', async () => {
    let shown = 0;
    const { script, sent } = commenting();
    const made = await makeWorld(script, on, { showDrafts: () => { shown++; } });
    const r = await made.call('social_comment', { url: POST, text: '  Worth the wait.  ' });
    const { drafts } = (await made.panel('state')).comments;
    expect(drafts).toMatchObject([{ platform: 'reddit', url: POST, target: 't3_r1', text: 'Worth the wait.' }]);
    expect(r.text).toBe(t.commentDrafted('social_comment', drafts[0]!.id));
    expect(shown).toBe(1);
    expect(sent).toEqual([]);
    expect(made.browser.requests).toEqual([]);
  });

  it('refuses another platform, a link elsewhere, a share link, an empty or too long text, and drafts past their limit', async () => {
    const made = await makeWorld({}, on);
    const refused = async (args: Record<string, unknown>) => (await made.call('social_comment', args)).text;
    expect(await refused({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', text: 'x' })).toBe(t.notRun('social_comment', t.commentPlatforms));
    expect(await refused({ url: 'https://fixture.test/post/1', text: 'x' })).toBe(t.notRun('social_comment', t.notPlatformUrl));
    expect(await refused({ url: `${REDDIT}/r/fixture/s/AbCdEf123`, text: 'x' })).toBe(t.notRun('social_comment', t.commentShareLink));
    expect(await refused({ url: `${REDDIT}/r/fixture/`, text: 'x' })).toBe(t.notRun('social_comment', t.commentNoTarget));
    expect(await refused({ url: 'javascript://www.reddit.com/r/fixture/comments/r1/x/%0Aalert(1)', text: 'x' })).toBe(t.notRun('social_comment', t.commentNoTarget));
    expect(await refused({ url: POST, text: '   ' })).toBe(t.notRun('social_comment', t.commentEmpty));
    expect(await refused({ url: POST, text: 'x'.repeat(BOT_COMMENT_MAX + 1) })).toBe(t.notRun('social_comment', t.commentTooLong(BOT_COMMENT_MAX)));
    for (let i = 0; i < DRAFTS_MAX; i++) await made.call('social_comment', { url: POST, text: `draft ${i}` });
    expect(await refused({ url: POST, text: 'one more' })).toBe(t.notRun('social_comment', t.commentDraftsFull(DRAFTS_MAX)));
    expect(await draftIds(made)).toHaveLength(DRAFTS_MAX);
  });

  it('refuses a draft on Reddit while Reddit is turned off', async () => {
    const made = await makeWorld({}, (cfg) => { on(cfg); cfg.platforms.reddit.enabled = false; });
    expect((await made.call('social_comment', { url: POST, text: 'x' })).text).toBe(t.notRun('social_comment', t.platformOff('Reddit')));
  });

  it('posts the text the person left in the draft, tells the bot at once and lists the comment', async () => {
    const { script, sent } = commenting();
    const made = await makeWorld(script, on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    const state = await made.panel('commentPost', id, ' Worth the wait, honestly. ');
    expect(sent).toEqual(['Worth the wait, honestly.']);
    expect(state.comments.drafts).toEqual([]);
    expect(state.comments.posted).toMatchObject([{ platform: 'reddit', url: POST, link: linkOf(1), text: 'Worth the wait, honestly.', edited: true }]);
    expect(state.comments.today).toBe(1);
    expect(made.host.events).toMatchObject([{ type: 'social.comment', origin: 'internal', text: t.commentPosted(POST, linkOf(1), 'Worth the wait, honestly.') }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'flush' }]);
  });

  it('says nothing of an edit when the person posts the draft as written', async () => {
    const { script } = commenting();
    const made = await makeWorld(script, on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    expect((await made.panel('commentPost', id, 'Worth the wait.')).comments.posted[0]!.edited).toBe(false);
    expect(made.host.events[0]!.text).toBe(t.commentPosted(POST, linkOf(1), null));
  });

  it('tells the bot of a discarded draft with the next batch', async () => {
    const { script, sent } = commenting();
    const made = await makeWorld(script, on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    expect((await made.panel('commentDiscard', id)).comments.drafts).toEqual([]);
    expect(sent).toEqual([]);
    expect(made.host.events).toMatchObject([{ type: 'social.comment', text: t.commentDiscarded(POST) }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'piggyback' }]);
    await expect(made.panel('commentPost', id, 'Worth the wait.')).rejects.toThrow(c.gone);
  });

  it("keeps a draft Reddit turned down and gives Reddit's reason in the panel's words", async () => {
    const { script } = commenting(() => json({ json: { errors: [['THREAD_LOCKED', 'Comments are locked.', 'parent']] } }));
    const made = await makeWorld(script, on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    await expect(made.panel('commentPost', id, 'Worth the wait.')).rejects.toThrow(c.refused('Reddit', 'THREAD_LOCKED: Comments are locked.'));
    expect(await draftIds(made)).toEqual([id]);
    expect(made.host.events).toEqual([]);
  });

  it('asks for a Reddit login in the panel when the browser has none', async () => {
    const made = await makeWorld(site({ [ME]: () => json({}) }), on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    await expect(made.panel('commentPost', id, 'Worth the wait.')).rejects.toThrow(c.login('Reddit'));
    expect(made.browser.requests).not.toContain(COMMENT);
  });

  it('stops at the daily limit, both drafting and posting', async () => {
    const { script, sent } = commenting();
    const made = await makeWorld(script, (cfg) => { on(cfg); cfg.comments.maxPerDay = 1; });
    await made.call('social_comment', { url: POST, text: 'one' });
    await made.call('social_comment', { url: POST, text: 'two' });
    const [a, b] = await draftIds(made);
    await made.panel('commentPost', a, 'one');
    await expect(made.panel('commentPost', b, 'two')).rejects.toThrow(c.dayFull(1));
    expect((await made.call('social_comment', { url: POST, text: 'three' })).text).toBe(t.notRun('social_comment', t.commentDayFull(1)));
    expect(sent).toEqual(['one']);
  });

  it('keeps drafts and the posted comments across a restart', async () => {
    const { script } = commenting();
    const first = await makeWorld(script, on);
    await first.call('social_comment', { url: POST, text: 'one' });
    await first.call('social_comment', { url: POST, text: 'two' });
    const [a, b] = await draftIds(first);
    await first.panel('commentPost', a, 'one');
    await first.world.stop();
    const again = await makeWorld(script, on, { dataDir: first.dataDir });
    const { comments } = await again.panel('state');
    expect(comments.drafts.map((d) => d.id)).toEqual([b]);
    expect(comments.posted.map((p) => p.text)).toEqual(['one']);
    expect(comments.today).toBe(1);
  });
});

describe('automatic comments and replies', () => {
  const POST = postUrl('r1');
  const ME = `${REDDIT}/api/me.json`;
  const COMMENT = `${REDDIT}/api/comment`;
  const UNREAD = `${REDDIT}/message/unread.json`;
  const c = socialText('en').comments;
  const linkOf = (n: number) => `${REDDIT}/r/fixture/comments/r1/fixture_r1/k${n}/`;
  const replyUrl = (id: string) => `${REDDIT}/r/fixture/comments/r1/fixture_r1/${id}/`;
  const MIN = 60_000;
  /** A reply in the inbox to one of the person's comments, made at `atMs`. */
  const reply = (id: string, author: string, atMs: number, over: Record<string, unknown> = {}) => ({
    kind: 't1',
    data: {
      id, name: `t1_${id}`, author, body: `Reply ${id}`, link_title: 'Fixture title r1', context: `/r/fixture/comments/r1/fixture_r1/${id}/?context=3`,
      created_utc: Math.floor(atMs / 1000), type: 'comment_reply', was_comment: true, new: true, ...over,
    },
  });
  /**
   * Reddit logged in as fixture_alice: the inbox holds `inbox.items`, and each comment posted is kept
   * with what it replies to; `answer(n)` answers the nth.
   */
  function reddit(answer?: (n: number) => FetchedText) {
    const inbox = { items: [] as unknown[] };
    const sent: Array<{ target: string; text: string }> = [];
    const script: PageScript = {
      fetch: (url, init) => {
        const u = new URL(url);
        if (url === ME) return json({ kind: 't2', data: { name: 'fixture_alice', modhash: 'fixturehash' } });
        if (u.origin + u.pathname === UNREAD) return json({ kind: 'Listing', data: { after: null, children: inbox.items } });
        if (url !== COMMENT) return undefined;
        const form = new URLSearchParams(init?.body);
        sent.push({ target: form.get('thing_id') ?? '', text: form.get('text') ?? '' });
        return answer?.(sent.length) ?? json({ json: { errors: [], data: { things: [{ kind: 't1', data: { id: `k${sent.length}`, link_id: 't3_r1', permalink: `/r/fixture/comments/r1/fixture_r1/k${sent.length}/` } }] } } });
      },
    };
    return { script, sent, inbox };
  }
  const set = (patch: Partial<SocialConfigSection['comments']>) => (cfg: SocialConfigSection) => { Object.assign(cfg.comments, { enabled: true }, patch); };

  /** A World whose automatic posts wait the least: the random draw is pinned at 0. */
  const automatic = (script: PageScript, patch: (cfg: SocialConfigSection) => void, extra: Partial<SocialWorldOptions> = {}) => makeWorld(script, patch, { random: () => 0, ...extra });

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('queues a comment with automatic comments on and sends it once its time comes, marked while marking is on', async () => {
    let shown = 0;
    const { script, sent } = reddit();
    const made = await automatic(script, set({ auto: true }), { showDrafts: () => { shown++; } });
    const due = new Date(made.browser.clock.now + FIRST_WAIT_MS).toISOString();
    expect((await made.call('social_comment', { url: POST, text: 'Worth the wait.' })).text).toBe(t.commentQueued('social_comment', localStamp(due, TZ)));
    expect((await made.panel('state')).comments.queued).toMatchObject([{ platform: 'reddit', kind: 'comment', target: 't3_r1', text: 'Worth the wait.', due }]);
    await waitFor(made, FIRST_WAIT_MS - 1000);
    expect(sent).toEqual([]);
    await waitFor(made, 1000);
    expect(sent).toEqual([{ target: 't3_r1', text: `Worth the wait.\n\n${AUTO_NOTE}` }]);
    expect(made.host.events).toMatchObject([{ type: 'social.posted', origin: 'internal', text: t.autoSent(t.kind.comment, 'Reddit', linkOf(1)) }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'piggyback' }]);
    const { comments } = await made.panel('state');
    expect(comments).toMatchObject({ queued: [], drafts: [], today: 1, posted: [{ text: 'Worth the wait.', auto: true, link: linkOf(1) }] });
    expect(shown).toBe(0);
  });

  it(`spaces automatic comments at least ${GAPS.comment / MIN} minutes apart, each wait varied by the draw`, async () => {
    const { script, sent } = reddit();
    const made = await makeWorld(script, set({ auto: true, sign: false }), { random: () => 0.5 });
    const start = made.browser.clock.now;
    await made.call('social_comment', { url: POST, text: 'one' });
    await made.call('social_comment', { url: POST, text: 'two' });
    const [a, b] = (await made.panel('state')).comments.queued;
    expect(Date.parse(a!.due)).toBe(start + 1.5 * FIRST_WAIT_MS);
    expect(Date.parse(b!.due)).toBe(Date.parse(a!.due) + 1.5 * GAPS.comment);
    await waitFor(made, 1.5 * FIRST_WAIT_MS);
    expect(sent.map((x) => x.text)).toEqual(['one']);
    await waitFor(made, 1.5 * GAPS.comment);
    expect(sent.map((x) => x.text)).toEqual(['one', 'two']);
  });

  it('keeps a comment with a link for the person even with automatic comments on', async () => {
    const { script, sent } = reddit();
    const made = await automatic(script, set({ auto: true }));
    const r = await made.call('social_comment', { url: POST, text: 'Their menu is at fixture.test/menu or https://fixture.test/menu' });
    const { drafts, queued } = (await made.panel('state')).comments;
    expect(r.text).toBe(t.commentHeld('social_comment', drafts[0]!.id, t.heldLink));
    expect(queued).toEqual([]);
    await waitFor(made, FIRST_WAIT_MS);
    expect(sent).toEqual([]);
  });

  it("makes an automatic comment Reddit turns down a draft, and tells the bot Reddit's reason", async () => {
    const { script } = reddit(() => json({ json: { errors: [['RATELIMIT', 'Take a break for 5 minutes.', 'ratelimit']] } }));
    const made = await automatic(script, set({ auto: true }));
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    await waitFor(made, FIRST_WAIT_MS);
    const { drafts, queued } = (await made.panel('state')).comments;
    expect(queued).toEqual([]);
    expect(drafts).toMatchObject([{ kind: 'comment', target: 't3_r1', text: 'Worth the wait.' }]);
    expect(made.host.events).toMatchObject([{ type: 'social.posted', text: t.autoHeld(t.kind.comment, 'Reddit', t.heldFailed(t.commentRefused('Reddit', 'RATELIMIT: Take a break for 5 minutes.')), drafts[0]!.id) }]);
  });

  it('makes a queued comment a draft when automatic comments were turned off before its time', async () => {
    const { script, sent } = reddit();
    const made = await automatic(script, set({ auto: true }));
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    made.cfg.comments.auto = false;
    await waitFor(made, FIRST_WAIT_MS);
    expect(sent).toEqual([]);
    const [draft] = (await made.panel('state')).comments.drafts;
    expect(made.host.events).toMatchObject([{ type: 'social.posted', text: t.autoHeld(t.kind.comment, 'Reddit', t.heldSwitchedOff, draft!.id) }]);
  });

  it('holds a queued comment from the panel as a draft, telling the bot with the next batch', async () => {
    const { script, sent } = reddit();
    const made = await automatic(script, set({ auto: true }));
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [queued] = (await made.panel('state')).comments.queued;
    const state = await made.panel('queueHold', queued!.id);
    expect(state.comments.queued).toEqual([]);
    expect(state.comments.drafts).toMatchObject([{ text: 'Worth the wait.', target: 't3_r1' }]);
    expect(made.host.events).toMatchObject([{ type: 'social.posted', text: t.heldByPerson(t.kind.comment, state.comments.drafts[0]!.id) }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'piggyback' }]);
    await waitFor(made, FIRST_WAIT_MS);
    expect(sent).toEqual([]);
    await expect(made.panel('queueHold', queued!.id)).rejects.toThrow(c.gone);
  });

  it('refuses to hold a queued comment while it is being sent', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { script, sent } = reddit();
    const answer = script.fetch!;
    script.fetch = async (url, init) => { if (url === COMMENT) await held; return answer(url, init); };
    const made = await automatic(script, set({ auto: true }));
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [queued] = (await made.panel('state')).comments.queued;
    await waitFor(made, FIRST_WAIT_MS);
    await expect(made.panel('queueHold', queued!.id)).rejects.toThrow(c.posting);
    release();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await made.panel('state')).comments).toMatchObject({ queued: [], drafts: [], today: 1 });
  });

  it("tells the bot once of the replies that came after automatic replies were turned on, leaving its own, the moderation bot's, mentions and old ones", async () => {
    const { script, inbox } = reddit();
    const made = await makeWorld(script, set({ autoReply: true }));
    const start = made.browser.clock.now;
    inbox.items = [reply('a1', 'fixture_bob', start - MIN)];
    await made.panel('checkReplies');
    expect(made.host.events).toEqual([]);
    made.browser.clock.now += 10 * MIN;
    inbox.items = [
      reply('a1', 'fixture_bob', start - MIN),
      reply('b2', 'fixture_bob', start + 5 * MIN),
      reply('c3', 'fixture_alice', start + 6 * MIN),
      reply('d4', 'AutoModerator', start + 6 * MIN),
      reply('e5', 'fixture_carol', start + 7 * MIN, { type: 'username_mention' }),
    ];
    const state = await made.panel('checkReplies');
    expect(state.comments.checkedAt).toBe(new Date(made.browser.clock.now).toISOString());
    expect(made.host.events).toMatchObject([{ type: 'social.reply', origin: 'external', text: t.repliesEvent([t.replyLine('u/fixture_bob', 'Fixture title r1', 'Reply b2', replyUrl('b2'))]) }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'flush' }]);
    await made.panel('checkReplies');
    expect(made.host.events).toHaveLength(1);
  });

  it('leaves a reply older than a day', async () => {
    const { script, inbox } = reddit();
    const made = await makeWorld(script, set({ autoReply: true }));
    await made.panel('checkReplies');
    made.browser.clock.now += REPLY_MAX_AGE_MS + 2 * MIN;
    inbox.items = [reply('b2', 'fixture_bob', made.browser.clock.now - REPLY_MAX_AGE_MS - MIN)];
    await made.panel('checkReplies');
    expect(made.host.events).toEqual([]);
  });

  it('queues its answer to a reply with automatic replies on and automatic comments off, for an hour', async () => {
    const { script, sent, inbox } = reddit();
    const made = await automatic(script, set({ autoReply: true }));
    const start = made.browser.clock.now;
    await made.panel('checkReplies');
    inbox.items = [reply('b2', 'fixture_bob', start + MIN), reply('f6', 'fixture_dan', start + MIN)];
    made.browser.clock.now += 2 * MIN;
    await made.panel('checkReplies');
    const due = new Date(made.browser.clock.now + FIRST_WAIT_MS).toISOString();
    expect((await made.call('social_comment', { url: replyUrl('b2'), text: 'Thanks, will do.' })).text).toBe(t.commentQueued('social_comment', localStamp(due, TZ)));
    await waitFor(made, FIRST_WAIT_MS);
    expect(sent).toEqual([{ target: 't1_b2', text: `Thanks, will do.\n\n${AUTO_NOTE}` }]);
    expect((await made.panel('state')).comments.posted[0]).toMatchObject({ auto: true, to: 'fixture_bob' });
    // a comment that answers no reply waits, and so does an answer after the hour
    const other = await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    expect(other.text).toMatch(/^\[social_comment\] Draft c\d+ waits/);
    made.browser.clock.now += REPLY_WAIT_MS + MIN;
    expect((await made.call('social_comment', { url: replyUrl('f6'), text: 'Agreed.' })).text).toMatch(/^\[social_comment\] Draft c\d+ waits/);
    expect((await made.panel('state')).comments.queued).toEqual([]);
  });

  it(`keeps an answer for the person once an account had ${REPLIES_PER_ACCOUNT} automatic answers today, queued ones too, bringing nothing up`, async () => {
    let shown = 0;
    const { script, inbox } = reddit();
    const made = await automatic(script, set({ autoReply: true }), { showDrafts: () => { shown++; } });
    const start = made.browser.clock.now;
    await made.panel('checkReplies');
    const ids = Array.from({ length: REPLIES_PER_ACCOUNT + 1 }, (_, i) => `r${i}x`);
    inbox.items = ids.map((id) => reply(id, 'fixture_bob', start + MIN));
    made.browser.clock.now += 2 * MIN;
    await made.panel('checkReplies');
    for (const id of ids.slice(0, -1)) await made.call('social_comment', { url: replyUrl(id), text: 'Sure.' });
    const last = await made.call('social_comment', { url: replyUrl(ids.at(-1)!), text: 'Sure.' });
    const { drafts, queued } = (await made.panel('state')).comments;
    expect(last.text).toBe(t.commentHeld('social_comment', drafts[0]!.id, t.heldAccount(REPLIES_PER_ACCOUNT)));
    expect(queued).toHaveLength(REPLIES_PER_ACCOUNT);
    expect(shown).toBe(0);
  });

  it('answers no reply from before automatic replies were last turned on', async () => {
    const { script, inbox } = reddit();
    const made = await makeWorld(script, set({ autoReply: true }));
    const start = made.browser.clock.now;
    await made.panel('checkReplies');
    // off, and the schedule looks: on again later, replies from the time it was off get no answer
    made.cfg.comments.autoReply = false;
    await vi.advanceTimersByTimeAsync(2 * SCHEDULE_MS);
    made.browser.clock.now += 10 * MIN;
    inbox.items = [reply('b2', 'fixture_bob', start + 5 * MIN)];
    made.cfg.comments.autoReply = true;
    await made.panel('checkReplies');
    expect(made.host.events).toEqual([]);
  });

  it('refuses to check the replies while automatic replies are off, and asks for a login when Reddit has none', async () => {
    const off = await makeWorld(reddit().script, set({}));
    await expect(off.panel('checkReplies')).rejects.toThrow(c.notWatching);
    const loggedOut = await makeWorld(site({ [ME]: () => json({}) }), set({ autoReply: true }));
    await expect(loggedOut.panel('checkReplies')).rejects.toThrow(c.login('Reddit'));
  });
});

describe('Substack', () => {
  const SUB = 'https://substack.com';
  const PUB = 'https://fixturewriter.substack.com';
  const POST = `${PUB}/p/autumn-walks`;
  const NOTE = `${SUB}/@fixturereader/note/c-101`;
  const SELF = `${SUB}/api/v1/user/profile/self`;
  const FEED = `${SUB}/api/v1/comment/feed`;
  const MIN = 60_000;
  /** Substack logged in as fixturewriter: keeps each write's address and body, and answers each with a new id. */
  function substack() {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const script: PageScript = {
      fetch: (url, init) => {
        if (url === SELF) return json({ id: 7001, handle: 'fixturewriter', name: 'Fixture Writer' });
        if (url === `${PUB}/api/v1/posts/autumn-walks`) return json({ id: 42, slug: 'autumn-walks', title: 'Autumn walks' });
        if (init?.method !== 'POST') return undefined;
        sent.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        return json({ id: 300 + sent.length });
      },
    };
    return { script, sent };
  }
  const noteLink = (n: number) => `${SUB}/@fixturewriter/note/c-${300 + n}`;
  const notes = (patch: Partial<SocialConfigSection['substack']> = {}) => (cfg: SocialConfigSection) => { Object.assign(cfg.substack, { notes: true }, patch); };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes no Note while Notes are off', async () => {
    const made = await makeWorld(substack().script);
    expect((await made.call('social_note', { text: 'Autumn is for long walks.' })).text).toBe(t.notRun('social_note', t.notesOff));
  });

  it('keeps a Note for the person and brings up the panel, then posts what the person left in it', async () => {
    let shown = 0;
    const { script, sent } = substack();
    const made = await makeWorld(script, notes(), { showDrafts: () => { shown++; } });
    const r = await made.call('social_note', { text: 'Autumn is for long walks.' });
    const [draft] = (await made.panel('state')).comments.drafts;
    expect(draft).toMatchObject({ platform: 'substack', kind: 'note', url: '', target: '', text: 'Autumn is for long walks.' });
    expect(r.text).toBe(t.commentDrafted('social_note', draft!.id));
    expect(shown).toBe(1);
    expect(sent).toEqual([]);
    const state = await made.panel('commentPost', draft!.id, 'Autumn is for long walks, and soup.');
    expect(sent).toEqual([{ url: FEED, body: expect.objectContaining({ bodyJson: noteDoc('Autumn is for long walks, and soup.') }) }]);
    expect(state.comments).toMatchObject({ posted: [], postedNotes: [{ kind: 'note', link: noteLink(1), edited: true }], notesToday: 1, today: 0 });
    expect(made.host.events).toMatchObject([{ type: 'social.comment', text: t.notePosted(noteLink(1), 'Autumn is for long walks, and soup.') }]);
  });

  it('replies to a Note by its number, and refuses a reply_to that is no Note, an empty text and Notes past the daily limit', async () => {
    const { script, sent } = substack();
    const made = await makeWorld(script, notes({ maxNotesPerDay: 1 }));
    expect((await made.call('social_note', { text: 'x', reply_to: POST })).text).toBe(t.notRun('social_note', t.noteNoTarget));
    expect((await made.call('social_note', { text: '  ' })).text).toBe(t.notRun('social_note', t.commentEmpty));
    await made.call('social_note', { text: 'Same here.', reply_to: NOTE });
    const [draft] = (await made.panel('state')).comments.drafts;
    expect(draft).toMatchObject({ url: NOTE, target: '101' });
    await made.panel('commentPost', draft!.id, 'Same here.');
    expect(sent[0]!.body).toMatchObject({ parent_id: 101 });
    expect((await made.call('social_note', { text: 'Another.' })).text).toBe(t.notRun('social_note', t.noteDayFull(1)));
  });

  it(`queues Notes with automatic Notes on, at least ${GAPS.note / MIN} minutes apart, each marked as sent automatically`, async () => {
    const { script, sent } = substack();
    const made = await makeWorld(script, notes({ autoNotes: true }), { random: () => 0 });
    const start = made.browser.clock.now;
    expect((await made.call('social_note', { text: 'First.' })).text).toBe(t.commentQueued('social_note', localStamp(new Date(start + FIRST_WAIT_MS).toISOString(), TZ)));
    await made.call('social_note', { text: 'Second.' });
    expect((await made.panel('state')).comments.queued.map((q) => Date.parse(q.due))).toEqual([start + FIRST_WAIT_MS, start + FIRST_WAIT_MS + GAPS.note]);
    await waitFor(made, FIRST_WAIT_MS);
    expect(sent.map((x) => x.body.bodyJson)).toEqual([noteDoc(`First.\n\n${SUBSTACK_AUTO_NOTE}`)]);
    expect(made.host.events).toMatchObject([{ type: 'social.posted', text: t.autoSent(t.kind.note, 'Substack', noteLink(1)) }]);
    await waitFor(made, GAPS.note);
    expect(sent).toHaveLength(2);
    expect((await made.panel('state')).comments).toMatchObject({ queued: [], notesToday: 2 });
  });

  it('keeps a Note with a link for the person even with automatic Notes on', async () => {
    const made = await makeWorld(substack().script, notes({ autoNotes: true }));
    const r = await made.call('social_note', { text: 'New post at fixturewriter.substack.com/p/autumn-walks' });
    const [draft] = (await made.panel('state')).comments.drafts;
    expect(r.text).toBe(t.commentHeld('social_note', draft!.id, t.heldLink));
  });

  it('comments on a Substack post, and points a reply to a Note to social_note', async () => {
    const { script, sent } = substack();
    const made = await makeWorld(script, (cfg) => { cfg.comments.enabled = true; });
    expect((await made.call('social_comment', { url: NOTE, text: 'x' })).text).toBe(t.notRun('social_comment', t.commentOnNote));
    expect((await made.call('social_comment', { url: `${PUB}/archive`, text: 'x' })).text).toBe(t.notRun('social_comment', t.commentNoSubstackPost));
    await made.call('social_comment', { url: POST, text: 'Well put.' });
    const [draft] = (await made.panel('state')).comments.drafts;
    expect(draft).toMatchObject({ platform: 'substack', kind: 'comment', target: POST });
    const state = await made.panel('commentPost', draft!.id, 'Well put.');
    expect(sent).toEqual([{ url: `${PUB}/api/v1/post/42/comment`, body: { body: 'Well put.' } }]);
    expect(state.comments.posted).toMatchObject([{ platform: 'substack', link: `${PUB}/p/autumn-walks/comment/301` }]);
  });

  it("creates a post draft in the person's publication, and none without one", async () => {
    const { script, sent } = substack();
    const made = await makeWorld(script);
    expect((await made.call('social_draft', { title: 'Autumn walks', body: 'Text.' })).text).toBe(t.notRun('social_draft', t.draftNoPublication));
    made.cfg.substack.publication = 'fixturewriter';
    expect((await made.call('social_draft', { title: ' ', body: 'Text.' })).text).toBe(t.notRun('social_draft', t.draftEmpty));
    expect((await made.call('social_draft', { title: 'Autumn walks', subtitle: 'And soup', body: '# Walks\n\nText.' })).text).toBe(t.draftCreated('Autumn walks', `${PUB}/publish/post/301`));
    expect(sent).toMatchObject([{ url: `${PUB}/api/v1/drafts`, body: { draft_title: 'Autumn walks', draft_subtitle: 'And soup' } }]);
  });

  it('asks for a daily Note at each planned time, brings up nothing for it, and lets a time missed by over an hour pass', async () => {
    let shown = 0;
    const times = planTimes(2, () => 0);
    const made = await makeWorld(substack().script, notes({ dailyNotes: 2, topic: 'Technology' }), { random: () => 0, showDrafts: () => { shown++; } });
    // midnight in Asia/Singapore
    const midnight = Date.parse('2026-10-22T16:00:00Z');
    made.browser.clock.now = midnight + (times[0]! - 1) * MIN;
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS);
    expect(made.host.events).toEqual([]);
    made.browser.clock.now = midnight + times[0]! * MIN;
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS);
    expect(made.host.events).toMatchObject([{ type: 'social.write', text: t.writeNote(1, 2, 'Technology') }]);
    expect(made.host.pushOpts).toEqual([{ trigger: 'flush' }]);
    await made.call('social_note', { text: 'Autumn is for long walks.' });
    expect(shown).toBe(0);
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS);
    expect(made.host.events).toHaveLength(1);
    // the app was closed from before the second time until over an hour after it
    made.browser.clock.now = midnight + (times[1]! + LATE_MIN + 1) * MIN;
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS);
    expect(made.host.events).toHaveLength(1);
  });

  it('plans the daily Notes between their hours, one in each equal part of them', () => {
    for (const draw of [0, 0.5, 0.999]) {
      const times = planTimes(3, () => draw);
      const part = (WRITE_TO_MIN - WRITE_FROM_MIN) / 3;
      times.forEach((m, i) => {
        expect(m).toBeGreaterThan(WRITE_FROM_MIN + part * i);
        expect(m).toBeLessThan(WRITE_FROM_MIN + part * (i + 1));
      });
    }
  });

  it('asks for no daily Note while Notes are off', async () => {
    const times = planTimes(1, () => 0);
    const made = await makeWorld(substack().script, (cfg) => { cfg.substack.dailyNotes = 1; }, { random: () => 0 });
    made.browser.clock.now = Date.parse('2026-10-22T16:00:00Z') + times[0]! * MIN;
    await vi.advanceTimersByTimeAsync(2 * SCHEDULE_MS);
    expect(made.host.events).toEqual([]);
  });
});
