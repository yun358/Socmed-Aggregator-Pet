/**
 * SocialWorld without a browser: the tools, the per-request limits, refusals, blocks and
 * interruptions, the lifetime counter, the panel, the daily autoscroll and comment drafts. Pages
 * are `ScriptedBrowser` pages answering Reddit's and Bilibili's JSON, timed on a test clock.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getByPath } from 'cortico/core/config-schema.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import type { ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { DigestStore, digestId, jobKey, localClock } from '../src/autoscroll.ts';
import type { FetchedText } from '../src/browser.ts';
import { DRAFTS_MAX } from '../src/comments.ts';
import { COMMENTS_PER_DAY_CAP, JOB_POSTS_CAP, MAX_JOBS, MAX_POSTS_CAP, MAX_SEC_CAP, SOCIAL_DEFAULTS, parseJobs, type AutoscrollJob, type SocialConfigSection } from '../src/config.ts';
import { SOCIAL } from '../src/definition.ts';
import { findBrowser } from '../src/find-browser.ts';
import { socialText } from '../src/i18n/index.ts';
import { MODEL_TEXT, type ModelLanguage } from '../src/model-text.ts';
import { Ocr, OcrImageError } from '../src/ocr.ts';
import { ADAPTERS } from '../src/platforms/index.ts';
import { REDDIT_COMMENT_MAX } from '../src/platforms/reddit.ts';
import { PLATFORM_IDS } from '../src/posts.ts';
import { COMMENT_TEXT_MAX, clock, localStamp } from '../src/render.ts';
import { SOCIAL_TOOL_DECLS } from '../src/tools.ts';
import { SocialWorld, type SocialPanelState, type SocialWorldOptions } from '../src/world.ts';
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
        comments: { enabled: cfg.comments.enabled, maxPerDay: cfg.comments.maxPerDay },
      },
      jobs: [],
      browser: findBrowser(cfg.browserFile),
      logins: {},
      checkingLogins: false,
      lifetime: expect.objectContaining({ sinceAt: expect.any(String) }),
      digests: [],
      running: null,
      comments: { drafts: [], posted: [], today: 0, posting: [] },
      caps: { maxPosts: MAX_POSTS_CAP, maxSec: MAX_SEC_CAP, jobPosts: JOB_POSTS_CAP, jobs: MAX_JOBS, commentsPerDay: COMMENTS_PER_DAY_CAP },
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
      'social.comments': t.envComments(cfg.comments.enabled, cfg.comments.maxPerDay),
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

  it('says whether comment drafts are on, with the daily limit', async () => {
    const { world, cfg } = await makeWorld({}, (c) => { c.comments.maxPerDay = 4; });
    expect((await world.envPromptVars())['social.comments']).toBe(t.envComments(false, 4));
    cfg.comments.enabled = true;
    expect((await world.envPromptVars())['social.comments']).toBe(t.envComments(true, 4));
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
    expect(r.text).toBe(t.commentDrafted(drafts[0]!.id));
    expect(shown).toBe(1);
    expect(sent).toEqual([]);
    expect(made.browser.requests).toEqual([]);
  });

  it('refuses another platform, a link elsewhere, a share link, an empty or too long text, and drafts past their limit', async () => {
    const made = await makeWorld({}, on);
    const refused = async (args: Record<string, unknown>) => (await made.call('social_comment', args)).text;
    expect(await refused({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', text: 'x' })).toBe(t.notRun('social_comment', t.commentRedditOnly));
    expect(await refused({ url: 'https://fixture.test/post/1', text: 'x' })).toBe(t.notRun('social_comment', t.notPlatformUrl));
    expect(await refused({ url: `${REDDIT}/r/fixture/s/AbCdEf123`, text: 'x' })).toBe(t.notRun('social_comment', t.commentShareLink));
    expect(await refused({ url: `${REDDIT}/r/fixture/`, text: 'x' })).toBe(t.notRun('social_comment', t.commentNoTarget));
    expect(await refused({ url: 'javascript://www.reddit.com/r/fixture/comments/r1/x/%0Aalert(1)', text: 'x' })).toBe(t.notRun('social_comment', t.commentNoTarget));
    expect(await refused({ url: POST, text: '   ' })).toBe(t.notRun('social_comment', t.commentEmpty));
    expect(await refused({ url: POST, text: 'x'.repeat(REDDIT_COMMENT_MAX + 1) })).toBe(t.notRun('social_comment', t.commentTooLong(REDDIT_COMMENT_MAX)));
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
    await expect(made.panel('commentPost', id, 'Worth the wait.')).rejects.toThrow(c.refused('THREAD_LOCKED: Comments are locked.'));
    expect(await draftIds(made)).toEqual([id]);
    expect(made.host.events).toEqual([]);
  });

  it('asks for a Reddit login in the panel when the browser has none', async () => {
    const made = await makeWorld(site({ [ME]: () => json({}) }), on);
    await made.call('social_comment', { url: POST, text: 'Worth the wait.' });
    const [id] = await draftIds(made);
    await expect(made.panel('commentPost', id, 'Worth the wait.')).rejects.toThrow(c.login);
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
