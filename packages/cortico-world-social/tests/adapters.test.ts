/**
 * The platform adapters end to end: SocialWorld's tools in a real Chromium, every request answered
 * from synthetic fixtures shaped like the platform's own pages and JSON. Skipped when no
 * Chromium-based browser is installed; the OCR case also needs `eng.traineddata` in
 * `scratch/social-smoke/ocr/`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ToolOutcome } from 'cortico/core/types.ts';
import { SOCIAL_DEFAULTS, type SocialConfigSection } from '../src/config.ts';
import { MODEL_TEXT } from '../src/model-text.ts';
import { Ocr } from '../src/ocr.ts';
import { wbiSign } from '../src/platforms/bilibili-parse.ts';
import { localStamp } from '../src/render.ts';
import { SocialWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FixtureBrowser, FixtureServer, findTestBrowser, html, jsonFixture, pageData, redirect, solidPng, type Fixture, type Router } from './helpers/live-browser.ts';

const EXE = findTestBrowser();
const OCR_DATA = fileURLToPath(new URL('../../../scratch/social-smoke/ocr/eng.traineddata', import.meta.url));
const TZ = 'Asia/Singapore';
const t = MODEL_TEXT.en;

describe.skipIf(!EXE)('adapters through the World', () => {
  let browser: FixtureBrowser;
  let server: FixtureServer;
  let dir: string;
  const cleanup: Array<() => unknown> = [];

  beforeAll(async () => {
    server = await FixtureServer.start();
    dir = mkdtempSync(join(tmpdir(), 'social-adapters-'));
    browser = new FixtureBrowser(EXE!, join(dir, 'profile'), server);
  });

  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  afterAll(async () => {
    await browser?.shutdown();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A started World on the suite's browser; OCR downloads fail, so no case reaches the network for them. */
  async function makeWorld(router: Router, patch: (c: SocialConfigSection) => void = () => {}, ocr?: Ocr) {
    browser.router = router;
    const cfg = structuredClone(SOCIAL_DEFAULTS);
    cfg.enabled = true;
    patch(cfg);
    const dataDir = mkdtempSync(join(dir, 'data-'));
    const world = new SocialWorld({
      cfg, timezone: TZ, dataDir, ocrDir: join(dataDir, 'ocr'), persist: () => {},
      modelLanguage: () => 'en', language: () => 'en', browser,
      ocr: ocr ?? new Ocr({ dataDir: join(dataDir, 'ocr'), fetch: async () => { throw new Error('no network in tests'); } }),
    });
    const host = new FakeHost();
    await world.start(host);
    cleanup.push(() => world.stop());
    const tools = new Map(world.tools().map((d) => [d.name, d]));
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
      const r = await tools.get(name)!.handler(args, { role: 'main', log: host.log });
      return typeof r === 'string' ? { text: r } : r;
    };
    return { world, host, cfg, call };
  }

  /* ---------- Reddit ---------- */

  const REDDIT = 'https://www.reddit.com';
  const redditPost = (id: string, over: Record<string, unknown> = {}) => ({
    kind: 't3',
    data: {
      id, name: `t3_${id}`, title: `Fixture title ${id}`, selftext: `Fixture text ${id}`, author: 'fixture_author', subreddit_name_prefixed: 'r/fixturebets',
      score: 120, num_comments: 14, created_utc: 1792634400, permalink: `/r/fixturebets/comments/${id}/fixture_${id}/`, ...over,
    },
  });
  const listing = (children: unknown[], after: string | null) => ({ kind: 'Listing', data: { after, dist: children.length, children } });
  const robots: Fixture = { body: 'User-agent: *\nDisallow:', contentType: 'text/plain' };

  describe('Reddit', () => {
    it('lists a subreddit page by page, leaving out pinned and video posts and attaching gallery images', async () => {
      const png = solidPng(64, 48);
      const g1 = server.put('/reddit/g1.png', png, 'image/png');
      const g2 = server.put('/reddit/g2.png', png, 'image/png');
      const page1 = listing([
        redditPost('p1', { stickied: true, title: 'Pinned rules' }),
        redditPost('p2'),
        redditPost('p3', { is_video: true, domain: 'v.redd.it', selftext: '' }),
        redditPost('p4', {
          selftext: '', url: 'https://www.reddit.com/gallery/p4',
          media_metadata: { m1: { e: 'Image', m: 'image/png', s: { u: `${g1}?width=64&amp;format=png` } }, m2: { e: 'Image', m: 'image/png', s: { u: `${g2}?width=64&amp;format=png` } } },
          gallery_data: { items: [{ media_id: 'm1', caption: 'First chart' }, { media_id: 'm2' }] },
        }),
        redditPost('p5', { selftext: '', url_overridden_by_dest: 'https://fixture.test/article', domain: 'fixture.test' }),
      ], 't3_p5');
      const page2 = listing([redditPost('p6'), redditPost('p7'), redditPost('p8')], 't3_p8');
      const asked: string[] = [];
      const { call, host } = await makeWorld((u) => {
        if (u.href === `${REDDIT}/robots.txt`) return robots;
        if (u.pathname !== '/r/fixturebets/hot.json') return null;
        asked.push(u.search);
        return jsonFixture(u.searchParams.get('after') === 't3_p5' ? page2 : page1);
      }, (c) => { c.images = 'model'; c.maxPosts = 5; });
      host.accepts = (mime) => mime === 'image/png';

      const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'r/fixturebets' });
      expect(r.text.startsWith(`[social_browse] Reddit, ${t.source('community', 'r/fixturebets', 'hot')}: ${t.posts(5, false)} in `)).toBe(true);
      expect(r.text).toContain(t.leftOut([t.leftVideo(1)]));
      expect(r.text).toContain(t.stopped.count);
      for (const id of ['p2', 'p4', 'p5', 'p6', 'p7']) expect(r.text).toContain(`${REDDIT}/r/fixturebets/comments/${id}/fixture_${id}/`);
      for (const id of ['p1', 'p3', 'p8']) expect(r.text).not.toContain(`/comments/${id}/`);
      expect(r.text).toContain('https://fixture.test/article');
      expect(r.text).toContain(t.imageAlt(1, 'First chart'));
      expect(r.text).toContain(t.imageAttached(1, 1));
      expect(r.text).toContain(t.imageAttached(2, 2));
      expect(r.blobs?.map((b) => 'bytes' in b && Buffer.from(b.bytes).equals(png))).toEqual([true, true]);
      expect(asked.map((q) => new URLSearchParams(q).get('after'))).toEqual([null, 't3_p5']);
      expect(server.hits.get('/reddit/g1.png')).toBe(1);
    });

    it('reads one post with its top comments', async () => {
      const thread = [
        listing([redditPost('p2', { selftext: 'The whole text of the post.' })], null),
        listing([
          { kind: 't1', data: { author: 'fixture_reply', body: 'First reply', score: 50 } },
          { kind: 't1', data: { author: '[deleted]', body: '[deleted]', score: 1 } },
          { kind: 't1', data: { author: 'fixture_other', body: 'Second reply', score: 7 } },
          { kind: 't1', data: { author: 'fixture_third', body: 'Third reply', score: 3 } },
          { kind: 'more', data: { count: 20 } },
        ], null),
      ];
      const { call } = await makeWorld((u) => {
        if (u.href === `${REDDIT}/robots.txt`) return robots;
        if (u.pathname === '/r/fixturebets/comments/p2/fixture_p2.json') return jsonFixture(thread);
        return null;
      });
      const r = await call('social_read', { url: `${REDDIT}/r/fixturebets/comments/p2/fixture_p2/`, comments: 2 });
      expect(r.text).toMatch(/^\[social_read\] Reddit, in \d+ s:/);
      expect(r.text).toContain('The whole text of the post.');
      expect(r.text).toContain([t.comments(2), t.comment('u/fixture_reply', 'First reply', '50 points'), t.comment('u/fixture_other', 'Second reply', '7 points')].join('\n'));
      expect(r.text).not.toContain('Third reply');
    });
  });

  /* ---------- YouTube ---------- */

  const YT = 'https://www.youtube.com';
  const ytPage = (name: string, data: unknown, extra = ''): Fixture => html(`<div id="content"></div>${extra}${pageData(name, data)}`);
  const runs = (text: string) => ({ runs: [{ text }] });
  const SEARCH = {
    contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
      { videoRenderer: {
        videoId: 'FIXTUREVID1', title: runs('Fixture riots explained'), ownerText: runs('Fixture News'), lengthText: { simpleText: '12:34' },
        viewCountText: { simpleText: '1,234 views' }, publishedTimeText: { simpleText: '2 days ago' }, detailedMetadataSnippets: [{ snippetText: runs('What happened and why.') }],
      } },
      { adSlotRenderer: { fulfillmentContent: { fulfilledLayout: { inFeedAdLayoutRenderer: { renderingContent: { videoRenderer: { videoId: 'FIXTUREAD01', title: { simpleText: 'Buy fixtures' } } } } } } } },
      { lockupViewModel: {
        contentId: 'FIXTUREVID2', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        contentImage: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '3:21' } }] } }] } },
        metadata: { lockupMetadataViewModel: { title: { content: 'Fixture square live' }, metadata: { contentMetadataViewModel: { metadataRows: [
          { metadataParts: [{ text: { content: 'Fixture Live' } }] },
          { metadataParts: [{ text: { content: '5K views' } }, { text: { content: '1 hour ago' } }] },
        ] } } } },
      } },
    ] } }] } } } },
  };
  const CHANNEL_ID = 'UCfixturechannel000000ab';
  const CHANNEL_META = { channelMetadataRenderer: { externalId: CHANNEL_ID, title: 'Fixture Channel' } };
  const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
 <title>Fixture Channel</title>
 <author><name>Fixture Channel</name></author>
 <entry>
  <yt:videoId>FIXTURENEW1</yt:videoId>
  <title>Newest fixture upload</title>
  <link rel="alternate" href="${YT}/watch?v=FIXTURENEW1"/>
  <author><name>Fixture Channel</name></author>
  <published>2026-10-21T10:00:00+00:00</published>
  <media:group><media:description>About the newest upload.</media:description><media:community><media:statistics views="1200"/></media:community></media:group>
 </entry>
 <entry>
  <yt:videoId>FIXTURESHT1</yt:videoId>
  <title>A fixture short</title>
  <link rel="alternate" href="${YT}/shorts/FIXTURESHT1"/>
  <author><name>Fixture Channel</name></author>
  <published>2026-10-20T10:00:00+00:00</published>
 </entry>
</feed>`;
  const json3 = (n: number, words: string) => ({ events: Array.from({ length: n }, (_, i) => ({ tStartMs: i * 10_000, dDurationMs: 9000, segs: [{ utf8: `${words} ${i}` }] })) });
  const player = (id: string, title: string, captions: boolean) => ({
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: id, title, author: 'Fixture News', lengthSeconds: '754', shortDescription: 'A fixture video.', viewCount: '1234' },
    ...(captions ? { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: `${YT}/api/timedtext?v=${id}&lang=en&caps=asr&xorb=2`, languageCode: 'en', name: runs('English (auto-generated)'), kind: 'asr' }] } } } : {}),
  });
  /** A watch page whose player fetches captions with the token YouTube asks for when told to show them. */
  const PLAYER_SCRIPT = (id: string) => `<div id="movie_player"></div><script>
    const p = document.getElementById('movie_player');
    p.mute = () => {}; p.loadModule = () => {}; p.playVideo = () => {};
    p.setOption = (module, option, value) => { if (module === 'captions' && option === 'track') fetch('/api/timedtext?v=${id}&lang=' + value.languageCode + '&fmt=json3&pot=fixture-token'); };
  </script>`;

  const youtube: Router = (u) => {
    if (u.origin !== YT) return null;
    if (u.pathname === '/results' && u.searchParams.get('search_query') === 'fixture riots') return ytPage('ytInitialData', SEARCH);
    if (u.pathname === '/@fixturechannel') return ytPage('ytInitialData', { metadata: CHANNEL_META });
    if (u.pathname === '/@fixturechannel/videos') {
      return ytPage('ytInitialData', { metadata: CHANNEL_META, contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [{ richItemRenderer: { content: { futureVideoViewModel: { id: 'FIXTURENEW1' } } } }] } } } }] } } });
    }
    if (u.pathname === '/feeds/videos.xml' && u.searchParams.get('channel_id') === CHANNEL_ID) return { body: FEED, contentType: 'application/atom+xml; charset=UTF-8' };
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      if (v === 'FIXTUREVID1') return ytPage('ytInitialPlayerResponse', player(v, 'Fixture riots explained', true));
      if (v === 'FIXTUREVID2') return ytPage('ytInitialPlayerResponse', player(v, 'Fixture square live', true), PLAYER_SCRIPT(v));
      if (v === 'FIXTUREVID3') return ytPage('ytInitialPlayerResponse', player(v, 'Fixture silent film', false));
    }
    if (u.pathname === '/api/timedtext' && u.searchParams.get('fmt') === 'json3') {
      const v = u.searchParams.get('v');
      if (v === 'FIXTUREVID1') return jsonFixture(json3(5, 'direct caption'));
      // like YouTube, the second video's captions need the player's token
      if (v === 'FIXTUREVID2') return u.searchParams.get('pot') ? jsonFixture(json3(5, 'player caption')) : { body: '', status: 403 };
    }
    return null;
  };

  describe('YouTube', () => {
    it('lists search results in both renderer shapes and leaves ads out', async () => {
      const { call } = await makeWorld(youtube);
      const r = await call('social_browse', { platform: 'youtube', source: 'search', query: 'fixture riots' });
      expect(r.text).toContain(t.posts(2, true));
      expect(r.text).toContain(t.stopped.end);
      expect(r.text).toContain(`[1] "Fixture riots explained" · Fixture News · 12:34 · 1,234 views · 2 days ago\n> What happened and why.\n${YT}/watch?v=FIXTUREVID1`);
      expect(r.text).toContain(`[2] "Fixture square live" · Fixture Live · 3:21 · 5K views · 1 hour ago\n${YT}/watch?v=FIXTUREVID2`);
      expect(r.text).not.toContain('FIXTUREAD01');
    });

    it('loads more results as it scrolls, from the continuation the page fetches', async () => {
      const video = (id: string, title: string) => ({ videoRenderer: { videoId: id, title: runs(title), ownerText: runs('Fixture News'), lengthText: { simpleText: '1:00' } } });
      const first = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
        { itemSectionRenderer: { contents: [video('FIXTUREMOR1', 'First result'), video('FIXTUREMOR2', 'Second result')] } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'fixture-token' } } } },
      ] } } } } };
      const more = { onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [
        { itemSectionRenderer: { contents: [video('FIXTUREMOR3', 'Third result'), video('FIXTUREMOR4', 'Fourth result')] } },
      ] } }] };
      const loads: string[] = [];
      const { call } = await makeWorld((u, request) => {
        if (u.pathname === '/results') {
          return ytPage('ytInitialData', first, `<div style="height:4000px"></div><script>
            let asked = false;
            window.addEventListener('scroll', () => { if (!asked) { asked = true; fetch('/youtubei/v1/search?prettyPrint=false', { method: 'POST', body: '{"continuation":"fixture-token"}' }); } });
          </script>`);
        }
        if (u.pathname === '/youtubei/v1/search') {
          loads.push(request.postData() ?? '');
          return jsonFixture(more);
        }
        return null;
      });
      const r = await call('social_browse', { platform: 'youtube', source: 'search', query: 'fixture more', max_posts: 3 });
      expect(r.text).toContain(t.posts(3, true));
      expect(r.text).toContain(t.stopped.count);
      for (const id of ['FIXTUREMOR1', 'FIXTUREMOR2', 'FIXTUREMOR3']) expect(r.text).toContain(`${YT}/watch?v=${id}`);
      expect(loads).toEqual(['{"continuation":"fixture-token"}']);
    });

    it("finds a channel by its handle and lists its feed when the videos page is in a layout it does not know", async () => {
      const { call } = await makeWorld(youtube);
      const r = await call('social_browse', { platform: 'youtube', source: 'account', query: '@fixturechannel' });
      expect(r.text).toContain(t.posts(2, true));
      expect(r.text).toContain(`"Newest fixture upload" · Fixture Channel · 1200 views`);
      expect(r.text).toContain(`${YT}/watch?v=FIXTURENEW1`);
      expect(r.text).toContain(`"A fixture short (Short)" · Fixture Channel`);
      expect(r.text).toContain(`${YT}/shorts/FIXTURESHT1`);
    });

    it('reads a transcript from the caption track the page names', async () => {
      const { call } = await makeWorld(youtube);
      const r = await call('social_transcript', { video: `${YT}/watch?v=FIXTUREVID1` });
      expect(r.text.split('\n')[0]).toBe(t.transcriptHead('Fixture riots explained', 'Fixture News', '12:34', 'English (auto-generated)', true));
      expect(r.text).toContain('[0:00] direct caption 0 direct caption 1 direct caption 2');
      expect(r.text).toContain('[0:30] direct caption 3 direct caption 4');
    });

    it("reads a transcript from the request the page's player makes when the track alone is refused", async () => {
      const { call } = await makeWorld(youtube);
      const r = await call('social_transcript', { video: 'FIXTUREVID2' });
      expect(r.text).toContain('[0:00] player caption 0 player caption 1 player caption 2');
      const timedtext = browser.seen.filter((u) => u.includes('/api/timedtext?v=FIXTUREVID2'));
      expect(timedtext.length).toBeGreaterThan(0);
      expect(timedtext.every((u) => u.includes('pot=fixture-token'))).toBe(true);
    });

    it('says when a video has no captions', async () => {
      const { call } = await makeWorld(youtube);
      expect((await call('social_transcript', { video: 'FIXTUREVID3' })).text).toBe(t.notRun('social_transcript', t.noTranscript('no-captions', 'Fixture silent film')));
    });
  });

  /* ---------- Bilibili ---------- */

  const BILI = 'https://www.bilibili.com';
  const BILI_API = 'https://api.bilibili.com';
  const KEYS = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
  const NAV = { code: -101, message: 'not logged in', data: { isLogin: false, wbi_img: { img_url: `https://i0.fixture.test/bfs/wbi/${KEYS.imgKey}.png`, sub_url: `https://i0.fixture.test/bfs/wbi/${KEYS.subKey}.png` } } };
  const CORS = { 'access-control-allow-origin': BILI, 'access-control-allow-credentials': 'true' };
  const api = (value: unknown) => jsonFixture(value, CORS);
  const BV1 = 'BV1Fx411c7Ab';
  const BV2 = 'BV1Gy411c7Cd';
  /** Whether a `wbi/` request carries the signature made with the keys `nav` gave. */
  const signedWell = (u: URL): boolean => {
    const params = Object.fromEntries(Array.from(u.searchParams).filter(([k]) => k !== 'w_rid' && k !== 'wts'));
    return u.search.slice(1) === wbiSign(params, KEYS, Number(u.searchParams.get('wts')));
  };

  function bilibili(subtitle: string): Router {
    return (u) => {
      if (u.href === `${BILI}/`) return html('<div id="app"></div>');
      if (u.origin !== BILI_API) return null;
      if (u.pathname === '/x/web-interface/nav') return api(NAV);
      if (u.pathname.includes('/wbi/') && !signedWell(u)) return api({ code: -403, message: 'bad signature' });
      if (u.pathname === '/x/web-interface/wbi/search/type' && u.searchParams.get('search_type') === 'video') {
        if (u.searchParams.get('page') !== '1') return api({ code: 0, data: { page: 2, result: [] } });
        return api({ code: 0, data: { page: 1, result: [
          { type: 'video', bvid: BV1, title: '<em class="keyword">Fixture</em> lecture one', author: 'Fixture Uploader', play: 12345, duration: '10:05', pubdate: 1792634400, description: 'The first lecture.' },
          { type: 'ketang', bvid: 'BV1Hz411c7Ef', title: 'A paid course' },
          { type: 'video', bvid: BV2, title: 'Fixture lecture two', author: 'Fixture Uploader', play: 678, duration: '3:20', pubdate: 1792548000, description: '' },
        ] } });
      }
      if (u.pathname === '/x/web-interface/view') {
        const bvid = u.searchParams.get('bvid');
        return api({ code: 0, data: { bvid, aid: 170001, cid: bvid === BV1 ? 279786 : 279787, title: bvid === BV1 ? 'Fixture lecture one' : 'Fixture lecture two', owner: { name: 'Fixture Uploader' }, duration: 605 } });
      }
      if (u.pathname === '/x/player/wbi/v2') {
        if (u.searchParams.get('bvid') === BV2) return api({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } });
        return api({ code: 0, data: { need_login_subtitle: false, subtitle: { subtitles: [{ lan: 'ai-en', lan_doc: 'English (generated)', type: 1, subtitle_url: subtitle }] } } });
      }
      return null;
    };
  }

  describe('Bilibili', () => {
    it('searches with a request signed by the keys nav gives, listing videos only', async () => {
      const { call } = await makeWorld(bilibili(''));
      const r = await call('social_browse', { platform: 'bilibili', source: 'search', query: 'fixture lecture' });
      expect(r.text).toContain(t.posts(2, true));
      expect(r.text).toContain(`"Fixture lecture one" · Fixture Uploader · 10:05 · views 12345`);
      expect(r.text).toContain(`${BILI}/video/${BV1}`);
      expect(r.text).toContain(`${BILI}/video/${BV2}`);
      expect(r.text).not.toContain('BV1Hz411c7Ef');
      expect(r.text).toContain(t.stopped.end);
    });

    it('reads a transcript from the subtitle file the player names', async () => {
      const subtitle = server.put('/bfs/ai_subtitle/sub1.json', JSON.stringify({ body: [
        { from: 0.2, to: 3, content: 'Welcome to the fixture lecture' },
        { from: 4, to: 8, content: 'Today we read fixtures' },
        { from: 41, to: 45, content: 'That is all' },
      ] }), 'application/json');
      const { call } = await makeWorld(bilibili(subtitle));
      const r = await call('social_transcript', { video: `${BILI}/video/${BV1}/?spm_id_from=fixture` });
      expect(r.text.split('\n')[0]).toBe(t.transcriptHead('Fixture lecture one', 'Fixture Uploader', '10:05', 'English (generated)', true));
      expect(r.text).toContain('[0:00] Welcome to the fixture lecture Today we read fixtures\n[0:41] That is all');
      expect(server.hits.get('/bfs/ai_subtitle/sub1.json')).toBe(1);
    });

    it("lists an uploader's videos from the space page when the API's risk control refuses", async () => {
      const base = bilibili('');
      const mid = 1234567;
      const { call } = await makeWorld((u, request) => {
        if (u.origin === BILI_API && u.pathname === '/x/web-interface/wbi/search/type' && u.searchParams.get('search_type') === 'bili_user') {
          return signedWell(u) ? api({ code: 0, data: { result: [{ mid, uname: '<em class="keyword">Fixture</em> Uploader' }] } }) : api({ code: -403 });
        }
        if (u.origin === BILI_API && u.pathname === '/x/space/wbi/arc/search') return api({ code: -352, message: 'risk control' });
        if (u.href === `https://space.bilibili.com/${mid}/upload/video`) {
          return html(min(`<div class="upload-video">
            <a href="//www.bilibili.com/video/${BV1}/" title="Fixture lecture one"><img src=""></a><a href="//www.bilibili.com/video/${BV1}/">Fixture lecture one</a>
            <a href="//www.bilibili.com/video/${BV2}/" title="Fixture lecture two"></a>
          </div>`));
        }
        return base(u, request);
      });
      const r = await call('social_browse', { platform: 'bilibili', source: 'account', query: 'Fixture Uploader' });
      expect(r.text).toContain(t.posts(2, true));
      expect(r.text).toContain(`[1] "Fixture lecture one"\n${BILI}/video/${BV1}`);
      expect(r.text).toContain(`[2] "Fixture lecture two"\n${BILI}/video/${BV2}`);
    });

    it('says the subtitles need a login when the player says so', async () => {
      const { call } = await makeWorld(bilibili(''));
      expect((await call('social_transcript', { video: BV2 })).text).toBe(t.notRun('social_transcript', t.noTranscript('login', 'Fixture lecture two')));
    });
  });

  /* ---------- page-read platforms ---------- */

  /** Markup as platforms serve it, with no whitespace between tags. */
  const min = (markup: string): string => markup.replace(/>\s+</g, '><').trim();

  describe('X', () => {
    it('reads the home timeline, leaving out ads and videos, and fetches the larger rendition of each photo', async () => {
      const photo = server.put('/x/photo1.png', solidPng(64, 48), 'image/png');
      const tweet = (handle: string, id: string, text: string, extra = '') => `<article data-testid="tweet" role="article">
        <div data-testid="User-Name"><div><a href="/${handle}"><span>Fixture ${id}</span></a></div><div><a href="/${handle}"><span>@${handle}</span></a></div>
        <div><a href="/${handle}/status/${id}"><time datetime="2026-10-21T0${id.slice(-1)}:00:00.000Z">Oct 21</time></a></div></div>
        <div data-testid="tweetText"><span>${text}</span></div>${extra}<div role="group" aria-label="2 replies, 5 likes"></div></article>`;
      const { call, host } = await makeWorld((u) => (u.href === 'https://x.com/home' ? html(min(`<main>
        ${tweet('fixture_ads', '1001', 'Buy fixtures', '<div data-testid="placementTracking"></div>')}
        ${tweet('fixture_one', '1002', 'Laksa in the east', `<div data-testid="tweetPhoto"><img alt="A bowl" src="${photo}?format=png&amp;name=small"></div>`)}
        ${tweet('fixture_two', '1003', 'A clip', '<div data-testid="videoPlayer"><video></video></div>')}
        ${tweet('fixture_three', '1004', 'Noodles at noon')}
      </main>`)) : null), (c) => { c.images = 'model'; });
      host.accepts = (mime) => mime === 'image/png';
      const r = await call('social_browse', { platform: 'x', source: 'feed', max_posts: 2 });
      expect(r.text).toContain(t.posts(2, false));
      expect(r.text).toContain(t.leftOut([t.leftVideo(1), t.leftAd(1)]));
      expect(r.text).toContain('[1] Fixture 1002 (@fixture_one) · ');
      expect(r.text).toContain(`Laksa in the east\n${t.imageAlt(1, 'A bowl')}\n${t.imageAttached(1, 1)}\nhttps://x.com/fixture_one/status/1002`);
      expect(r.text).toContain('https://x.com/fixture_three/status/1004');
      expect(r.blobs).toHaveLength(1);
      expect(server.requested).toContain('/x/photo1.png?format=png&name=medium');
    });
  });

  describe('Instagram', () => {
    const IG = 'https://www.instagram.com';

    it("lists an account's posts from the site's own JSON, leaving out its videos", async () => {
      const png = solidPng(64, 64);
      const photo = server.put('/ig/c0de1.png', png, 'image/png');
      const profile = { data: { user: { username: 'fixture.eats', edge_owner_to_timeline_media: { count: 2, edges: [
        { node: { shortcode: 'C0DE1', is_video: false, display_url: photo, accessibility_caption: 'Photo of a sushi counter', taken_at_timestamp: 1792634400, edge_liked_by: { count: 12 }, edge_media_to_comment: { count: 3 }, edge_media_to_caption: { edges: [{ node: { text: 'Omakase night' } }] } } },
        { node: { shortcode: 'V1DE0', is_video: true, display_url: photo, edge_media_to_caption: { edges: [{ node: { text: 'A clip' } }] } } },
      ] } } } };
      const headers: string[] = [];
      const { call, host } = await makeWorld((u, request) => {
        if (u.href === `${IG}/`) return html('<main></main>');
        if (u.pathname === '/api/v1/users/web_profile_info/' && u.searchParams.get('username') === 'fixture.eats') {
          headers.push(request.headers()['x-ig-app-id'] ?? '');
          return jsonFixture(profile);
        }
        return null;
      }, (c) => { c.images = 'model'; });
      host.accepts = (mime) => mime === 'image/png';
      const r = await call('social_browse', { platform: 'instagram', source: 'account', query: '@fixture.eats' });
      expect(r.text).toContain(t.posts(1, false));
      expect(r.text).toContain(t.leftOut([t.leftVideo(1)]));
      expect(r.text).toContain(`Omakase night\n${t.imageAlt(1, 'Photo of a sushi counter')}\n${t.imageAttached(1, 1)}\n${IG}/p/C0DE1/`);
      // the JSON answers only requests that carry the web app's id
      expect(headers).toHaveLength(1);
      expect(headers[0]).not.toBe('');
    });

    it('reads one post page with its author, caption, time and photo', async () => {
      const avatar = server.put('/ig/avatar.png', solidPng(32, 32), 'image/png');
      const photo = server.put('/ig/post.png', solidPng(600, 600), 'image/png');
      const { call } = await makeWorld((u) => (u.href === `${IG}/p/C0DE1/` ? html(min(`<main><article>
        <header><div><a href="/fixture.eats/"><img alt="fixture.eats's profile picture" src="${avatar}" width="32" height="32"></a></div><div><a href="/fixture.eats/">fixture.eats</a></div></header>
        <div><img alt="Photo of a sushi counter" src="${photo}" width="600" height="600"></div>
        <div><h1>Omakase night at a fixture counter</h1></div>
        <div><a href="/p/C0DE1/"><time datetime="2026-10-18T12:00:00.000Z">Oct 18</time></a></div>
      </article></main>`)) : null), (c) => { c.images = 'skip'; });
      const r = await call('social_read', { url: `${IG}/p/C0DE1/?igsh=fixture` });
      expect(r.text).toContain(`[1] fixture.eats · ${localStamp('2026-10-18T12:00:00.000Z', TZ)}`);
      expect(r.text).toContain(`Omakase night at a fixture counter\n${t.imageAlt(1, 'Photo of a sushi counter')}\n${IG}/p/C0DE1/`);
      expect(r.text).not.toContain('profile picture');
    });
  });

  describe('Rednote', () => {
    const XHS = 'https://www.xiaohongshu.com';
    const NOTE = '64f0000000000000000000a1';
    const VIDEO_NOTE = '64f0000000000000000000a2';

    it('reads the explore cards and opens each note for its whole text and images; video notes are left out', async () => {
      const png = solidPng(48, 64);
      const image1 = server.put('/xhs/1.png', png, 'image/png');
      const image2 = server.put('/xhs/2.png', png, 'image/png');
      const card = (id: string, token: string, type: string, title: string) => ({ id, modelType: 'note', xsecToken: token, noteCard: { type, displayTitle: title, user: { nickname: 'fixture eater' }, interactInfo: { likedCount: '1.2k' }, cover: { urlDefault: image1 } } });
      const explore = { feed: { feeds: { __v_isRef: true, _rawValue: [card(VIDEO_NOTE, 'XT2', 'video', 'Fixture video'), card(NOTE, 'XT1', 'normal', 'Fixture noodle notes')] } } };
      const note = { note: { noteDetailMap: { [NOTE]: { note: {
        title: 'Fixture noodle notes', desc: 'Three bowls, one winner.', type: 'normal', time: 1792634400000, user: { nickname: 'fixture eater' },
        interactInfo: { likedCount: '1.2k', collectedCount: '300', commentCount: '45' }, imageList: [{ urlDefault: image1 }, { urlDefault: image2 }], tagList: [{ name: 'noodles' }],
      } } } } };
      const opened: string[] = [];
      const { call, host } = await makeWorld((u) => {
        if (u.href === `${XHS}/explore`) {
          return html(`<div class="feeds-container">${[VIDEO_NOTE, NOTE].map((id) => `<section class="note-item"><a class="cover" href="/explore/${id}"></a></section>`).join('')}</div>${pageData('__INITIAL_STATE__', explore)}`);
        }
        if (u.pathname.startsWith('/explore/')) {
          opened.push(u.pathname + u.search);
          if (u.pathname === `/explore/${NOTE}`) return html(`<div id="noteContainer"></div>${pageData('__INITIAL_STATE__', note)}`);
        }
        return null;
      }, (c) => { c.images = 'model'; });
      host.accepts = (mime) => mime === 'image/png';
      const r = await call('social_browse', { platform: 'rednote', source: 'feed', max_posts: 1 });
      expect(r.text).toContain(t.posts(1, false));
      expect(r.text).toContain(t.leftOut([t.leftVideo(1)]));
      expect(r.text).toContain(`[1] fixture eater · ${localStamp(new Date(1792634400000).toISOString(), TZ)} · likes 1.2k · saves 300 · comments 45\nTitle: Fixture noodle notes\n> Three bowls, one winner.\n> #noodles\n${t.imageAttached(1, 1)}\n${t.imageAttached(2, 2)}`);
      expect(r.text).toContain(`${XHS}/explore/${NOTE}?xsec_token=XT1&xsec_source=pc_feed`);
      expect(opened).toEqual([`/explore/${NOTE}?xsec_token=XT1&xsec_source=pc_feed`]);
      expect(r.blobs).toHaveLength(2);
    });
  });

  describe('Facebook', () => {
    it("reads a group's feed with each post's text expanded, leaving out ads", async () => {
      const post = (n: number, author: string, message: string, extra = '') => `<div><div aria-posinset="${n}">
        <h3><a href="https://www.facebook.com/fixture.${n}">${author}</a></h3>
        <div><a href="https://www.facebook.com/groups/fixturegroup/posts/${n}000/?__cft__[0]=AZ&amp;__tn__=R"><span>${n}h</span></a></div>
        ${extra}<div data-ad-rendering-role="story_message"><div dir="auto">${message}</div></div>
      </div></div>`;
      const { call } = await makeWorld((u) => (u.href === 'https://www.facebook.com/groups/fixturegroup' ? html(min(`<div role="feed">
        ${post(1, 'Fixture Member', 'Where to find laksa<div role="button">See more</div>')}
        ${post(2, 'Fixture Brand', 'Gloves on sale', '<div data-ad-rendering-role="meta"><span>Sponsored</span></div>')}
        ${post(3, 'Fixture Other', 'Try the stall by the river')}
      </div>
      <script>
        for (const b of document.querySelectorAll('[role="button"]')) b.addEventListener('click', () => { b.closest('[dir="auto"]').textContent = 'Where to find laksa in the east, and when the stalls open.'; });
      </script>`)) : null));
      const r = await call('social_browse', { platform: 'facebook', source: 'community', query: 'fixturegroup', max_posts: 2 });
      expect(r.text).toContain(t.posts(2, false));
      expect(r.text).toContain(t.leftOut([t.leftAd(1)]));
      expect(r.text).toContain('[1] Fixture Member\n> Where to find laksa in the east, and when the stalls open.\nhttps://www.facebook.com/groups/fixturegroup/posts/1000/');
      expect(r.text).toContain('[2] Fixture Other\n> Try the stall by the river\nhttps://www.facebook.com/groups/fixturegroup/posts/3000/');
    });
  });

  /* ---------- blocks ---------- */

  describe('blocks', () => {
    it('X: the login wall fails the listing and names social_login', async () => {
      const { call } = await makeWorld((u) => {
        if (u.href === 'https://x.com/home') return redirect('https://x.com/i/flow/login?redirect_after_login=%2Fhome');
        if (u.pathname === '/i/flow/login') return html('<div id="react-root"><h1>Sign in</h1></div>');
        return null;
      });
      expect(await call('social_browse', { platform: 'x', source: 'feed' })).toEqual({ text: t.failed('social_browse', t.blocked('X', 'x', 'login', '')), failed: true });
    });

    it('Rednote: the captcha page fails the listing and names social_login', async () => {
      const captcha = 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore&verifyType=102';
      const { call } = await makeWorld((u) => {
        if (u.href === 'https://www.xiaohongshu.com/explore') return redirect(captcha);
        if (u.pathname === '/website-login/captcha') return html('<div id="app"><div class="captcha">Verify</div></div>');
        return null;
      });
      expect(await call('social_browse', { platform: 'rednote', source: 'feed' })).toEqual({ text: t.failed('social_browse', t.blocked('Rednote', 'rednote', 'captcha', '')), failed: true });
    });
  });

  /* ---------- OCR ---------- */

  describe.skipIf(!existsSync(OCR_DATA))('OCR', () => {
    it('reads the text in a post image', { timeout: 90_000 }, async () => {
      const render = await chromium.launch({ executablePath: EXE!, headless: true });
      let png: Buffer;
      try {
        const page = await render.newPage({ viewport: { width: 720, height: 140 } });
        await page.setContent('<body style="margin:0;background:#fff"><div style="font:40px sans-serif;padding:36px 24px;color:#000">Fixture noodle bar opens at nine</div></body>');
        png = await page.screenshot({ type: 'png' });
      } finally {
        await render.close();
      }
      const image = server.put('/reddit/menu.png', png, 'image/png');
      const ocrDir = join(dir, 'ocr-data');
      mkdirSync(ocrDir, { recursive: true });
      copyFileSync(OCR_DATA, join(ocrDir, 'eng.traineddata'));
      const ocr = new Ocr({ dataDir: ocrDir, fetch: async () => { throw new Error('no network in tests'); } });
      cleanup.push(() => ocr.release());
      const { call } = await makeWorld((u) => {
        if (u.href === `${REDDIT}/robots.txt`) return robots;
        if (u.pathname === '/r/fixtureocr/hot.json') return jsonFixture(listing([redditPost('m1', { selftext: '', post_hint: 'image', url: image })], null));
        return null;
      }, () => {}, ocr);
      const r = await call('social_browse', { platform: 'reddit', source: 'community', query: 'fixtureocr' });
      expect(r.text).toMatch(/Image 1, text read by OCR \(may contain errors\): .*noodle bar/i);
    });
  });
});
