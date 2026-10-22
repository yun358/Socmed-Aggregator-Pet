/**
 * The in-page readers of `platforms/dom.ts` and `scrollCollect`, run in a real Chromium on
 * synthetic pages shaped like each platform's markup. Skipped when no Chromium-based browser is
 * installed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageSession } from '../src/browser.ts';
import { Collector, Deadline, scrollCollect } from '../src/collect.ts';
import {
  DOM_READ_DEFAULTS, expandFacebookPosts, readFacebookPosts, readGenericPosts, readInstagramPosts, readRednoteCards,
  readRednoteNote, readThreadsPosts, readXPosts, rednoteBlocked, type DomPost,
} from '../src/platforms/dom.ts';
import { FixtureBrowser, FixtureServer, findTestBrowser, html, pageData, solidPng } from './helpers/live-browser.ts';

const EXE = findTestBrowser();
const ORIGIN = 'https://fixture.test';

/** Markup as platforms serve it, with no whitespace between tags. */
const min = (markup: string): string => markup.replace(/>\s+</g, '><').trim();

/** Waits for the page's images, so their rendered sizes are known. */
const imagesLoaded = async () => { await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => undefined))); };

const post = (over: Partial<DomPost>): DomPost => ({ key: '', url: '', author: '', text: '', time: '', timeText: '', images: [], video: false, stats: [], ad: false, truncated: false, ...over });

describe.skipIf(!EXE)('in-page readers', () => {
  let browser: FixtureBrowser;
  let server: FixtureServer;
  let dir: string;
  let img: (name: string, width: number, height: number) => string;

  beforeAll(async () => {
    server = await FixtureServer.start();
    dir = mkdtempSync(join(tmpdir(), 'social-readers-'));
    browser = new FixtureBrowser(EXE!, join(dir, 'profile'), server);
    img = (name, width, height) => server.put(`/img/${name}.png`, solidPng(width, height), 'image/png');
  });

  afterAll(async () => {
    await browser?.shutdown();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Opens `body` at `path` on the fixture origin and runs `fn` on the page once its images loaded. */
  async function onPage<T>(body: string, fn: (page: PageSession) => Promise<T>, path = '/page'): Promise<T> {
    const url = ORIGIN + path;
    browser.router = (u) => (u.href === url ? html(min(body)) : null);
    return await browser.withPage(async (page) => {
      await page.goto(url);
      await page.run(imagesLoaded, undefined);
      return await fn(page);
    }, { timeLeft: () => 30_000 });
  }

  describe('readXPosts', () => {
    const tweet = (o: { handle: string; name: string; id?: string; text: string; media?: string; quote?: string; showMore?: boolean; ad?: boolean; tall?: boolean }) => `
      <article data-testid="tweet" role="article" tabindex="0"${o.tall ? ' style="min-height:700px"' : ''}>
        <div data-testid="User-Name">
          <div><a href="/${o.handle}" role="link"><span>${o.name}</span></a></div>
          <div><a href="/${o.handle}" role="link" tabindex="-1"><span>@${o.handle}</span></a></div>
          <div aria-hidden="true"><span>·</span></div>
          ${o.id ? `<div><a href="/${o.handle}/status/${o.id}"><time datetime="2026-10-20T08:00:00.000Z">Oct 20</time></a></div>` : ''}
        </div>
        <div data-testid="tweetText" lang="en"><span>${o.text}</span></div>
        ${o.showMore ? '<button type="button" data-testid="tweet-text-show-more-link">Show more</button>' : ''}
        ${o.media ?? ''}
        ${o.quote ? `<div role="link" tabindex="0"><div data-testid="User-Name"><div><span>Quoted Person</span></div><div><span>@quoted_person</span></div><div><time datetime="2026-10-19T08:00:00.000Z">Oct 19</time></div></div><div data-testid="tweetText"><span>${o.quote}</span></div></div>` : ''}
        ${o.ad ? '<div><span>Ad</span></div>' : ''}
        <div role="group" aria-label="4 replies, 9 reposts, 120 likes, 5000 views"><button>4</button><button>9</button></div>
      </article>`;

    it('reads the author, handle, time, link, text, photos, counts and markers of each post', async () => {
      const photo = img('x-photo', 600, 400);
      const plain = img('x-plain', 600, 400);
      const posts = await onPage(`<main>
        ${tweet({ handle: 'fixture_one', name: 'Fixture One', id: '1001', text: 'Ramen spots worth the queue', media: `<div data-testid="tweetPhoto"><img alt="A bowl of ramen" src="${photo}?format=png&amp;name=small"></div><div data-testid="tweetPhoto"><img alt="Image" src="${plain}"></div>` })}
        ${tweet({ handle: 'fixture_two', name: 'Fixture Two', id: '1002', text: 'My take on this', quote: 'The quoted claim', showMore: true })}
        ${tweet({ handle: 'fixture_three', name: 'Fixture Three', id: '1003', text: 'Watch this', media: '<div data-testid="videoPlayer"><video></video></div>' })}
        ${tweet({ handle: 'fixture_ads', name: 'Fixture Ads', text: 'Buy fixtures today', ad: true })}
      </main>`, (page) => page.run(readXPosts, DOM_READ_DEFAULTS));
      const stats: DomPost['stats'] = [['', '4 replies, 9 reposts, 120 likes, 5000 views']];
      expect(posts).toEqual([
        post({
          key: `${ORIGIN}/fixture_one/status/1001`, url: `${ORIGIN}/fixture_one/status/1001`, author: 'Fixture One (@fixture_one)',
          text: 'Ramen spots worth the queue', time: '2026-10-20T08:00:00.000Z', stats,
          images: [{ url: `${photo}?format=png&name=small`, alt: 'A bowl of ramen' }, { url: plain, alt: '' }],
        }),
        post({
          key: `${ORIGIN}/fixture_two/status/1002`, url: `${ORIGIN}/fixture_two/status/1002`, author: 'Fixture Two (@fixture_two)',
          text: 'My take on this\n[quoted] The quoted claim', time: '2026-10-20T08:00:00.000Z', stats, truncated: true,
        }),
        post({
          key: `${ORIGIN}/fixture_three/status/1003`, url: `${ORIGIN}/fixture_three/status/1003`, author: 'Fixture Three (@fixture_three)',
          text: 'Watch this', time: '2026-10-20T08:00:00.000Z', stats, video: true,
        }),
        post({ key: '@fixture_ads:Buy fixtures today', author: 'Fixture Ads (@fixture_ads)', text: 'Buy fixtures today', stats, ad: true }),
      ]);
    });

    it('reads posts a page adds while it is scrolled, until the collector has enough', async () => {
      const more = [
        tweet({ handle: 'fixture_ads', name: 'Fixture Ads', text: 'Buy fixtures today', ad: true, tall: true }),
        tweet({ handle: 'fixture_four', name: 'Fixture Four', id: '1004', text: 'Fourth', media: '<div data-testid="videoPlayer"><video></video></div>', tall: true }),
        ...['1005', '1006', '1007'].map((id) => tweet({ handle: `fixture_${id}`, name: `Fixture ${id}`, id, text: `Post ${id}`, tall: true })),
      ];
      const collector = new Collector('x', 5, 'ocr', new Deadline(20_000));
      await onPage(`<main id="timeline">${['1001', '1002', '1003'].map((id) => tweet({ handle: `fixture_${id}`, name: `Fixture ${id}`, id, text: `Post ${id}`, tall: true })).join('')}</main>
        <script>
          const more = ${JSON.stringify(more.map(min))};
          let added = false;
          window.addEventListener('scroll', () => {
            if (added || window.scrollY + window.innerHeight < document.body.scrollHeight - 1000) return;
            added = true;
            document.getElementById('timeline').insertAdjacentHTML('beforeend', more.join(''));
          });
        </script>`, (page) => scrollCollect(page, collector, { reader: readXPosts, ready: 'article[data-testid="tweet"]' }));
      expect(collector.posts.map((p) => p.url)).toEqual(['1001', '1002', '1003', '1005', '1006'].map((id) => `${ORIGIN}/fixture_${id}/status/${id}`));
      expect(collector.posts.every((p) => p.extraction === 'adapter')).toBe(true);
      expect(collector.skipped).toEqual({ video: 1, image: 0, ad: 1 });
      expect(collector.stopReason(false)).toBe('count');
    });

    it('hands the page to the generic reader when the platform reader finds nothing on it', async () => {
      const collector = new Collector('x', 5, 'ocr', new Deadline(10_000));
      await onPage(`<main>
        <article><p>A post in a layout the platform reader does not know, long enough to read.</p><a href="/fixture/status/1"><time datetime="2026-10-20T08:00:00Z">1h</time></a></article>
        <article><p>A second post in the same unknown layout.</p><a href="/fixture/status/2"><time datetime="2026-10-20T07:00:00Z">2h</time></a></article>
      </main>`, (page) => scrollCollect(page, collector, { reader: readXPosts }));
      expect(collector.posts.map((p) => [p.url, p.extraction])).toEqual([[`${ORIGIN}/fixture/status/1`, 'generic'], [`${ORIGIN}/fixture/status/2`, 'generic']]);
      expect(collector.generic).toBe(true);
      expect(collector.stopReason(false)).toBe('end');
    });
  });

  describe('readThreadsPosts', () => {
    it('reads each post once with its quote inside it, leaving profile pictures and sponsored posts apart', async () => {
      const avatar = img('threads-avatar', 36, 36);
      const bigAvatar = img('threads-big-avatar', 150, 150);
      const photo = img('threads-photo', 400, 300);
      const posts = await onPage(`
        <div data-pressable-container="true">
          <div><a href="/@fixture.cook"><img alt="fixture.cook's profile picture" src="${avatar}" width="36" height="36"></a></div>
          <div><a href="/@fixture.cook">fixture.cook</a></div>
          <div><a href="/@fixture.cook/post/C001"><time datetime="2026-10-21T10:00:00.000Z">1d</time></a></div>
          <div><span>Best laksa near the river?</span></div>
          <div><img alt="Photo by fixture.cook" src="${photo}" width="400" height="300"></div>
          <div><img alt="fixture.guest's profile picture" src="${bigAvatar}" width="150" height="150"></div>
          <div data-pressable-container="true">
            <div><a href="/@fixture.other">fixture.other</a></div>
            <div><time datetime="2026-10-19T10:00:00.000Z">3d</time></div>
            <div><span>Quoted bowl review</span></div>
            <div><a href="/@fixture.other/post/C000">Open</a></div>
          </div>
          <div><div role="button">Like</div><span>12</span></div>
          <div><span>Translate</span></div>
        </div>
        <div data-pressable-container="true">
          <div><a href="/@fixture.brand">fixture.brand</a></div>
          <div><span>Sponsored</span></div>
          <div><span>Fixture bowls, now in stores</span></div>
        </div>
        <div data-pressable-container="true">
          <div><a href="/@fixture.writer">fixture.writer</a></div>
          <div><a href="/@fixture.writer/post/C002"><time datetime="2026-10-21T11:00:00.000Z">1d</time></a></div>
          <div><span>Sponsored content is everywhere lately, and this post is about that.</span></div>
        </div>`, (page) => page.run(readThreadsPosts, DOM_READ_DEFAULTS));
      expect(posts).toEqual([
        post({
          key: `${ORIGIN}/@fixture.cook/post/C001`, url: `${ORIGIN}/@fixture.cook/post/C001`, author: 'fixture.cook',
          text: 'Best laksa near the river?\nQuoted bowl review', time: '2026-10-21T10:00:00.000Z',
          images: [{ url: photo, alt: 'Photo by fixture.cook' }],
        }),
        post({ key: 'fixture.brand:Sponsored\nFixture bowls, now in stores', author: 'fixture.brand', text: 'Sponsored\nFixture bowls, now in stores', ad: true }),
        post({
          key: `${ORIGIN}/@fixture.writer/post/C002`, url: `${ORIGIN}/@fixture.writer/post/C002`, author: 'fixture.writer',
          text: 'Sponsored content is everywhere lately, and this post is about that.', time: '2026-10-21T11:00:00.000Z',
        }),
      ]);
    });
  });

  describe('readInstagramPosts', () => {
    it('reads the author, link, caption and photo of each feed post; reels are videos, sponsored posts ads', async () => {
      const avatar = img('ig-avatar', 32, 32);
      const photo = img('ig-photo', 468, 468);
      const header = (user: string, link: string, extra = '') => `<header>
        <a href="/${user}/"><img alt="${user}'s profile picture" src="${avatar}" width="32" height="32"></a>
        <div><a href="/${user}/">${user}</a>${extra}</div>
        <div><span>•</span><a href="${link}"><time datetime="2026-10-18T12:00:00.000Z">4d</time></a></div>
        <div><button>Follow</button></div>
      </header>`;
      const posts = await onPage(`<main>
        <article>
          ${header('fixture.eats', '/p/C0DE1/')}
          <div><img alt="Photo of a sushi counter" src="${photo}" width="468" height="468"></div>
          <section><button>Like</button><button>Comment</button></section>
          <div><span>Liked by fixture.friend and others</span></div>
          <div><span><a href="/fixture.eats/">fixture.eats</a></span></div>
          <div><h1>Omakase night at a fixture counter</h1></div>
          <div><span>View all 12 comments</span></div>
          <form><textarea aria-label="Add a comment"></textarea></form>
        </article>
        <article>
          ${header('fixture.clips', '/reel/R33L1/')}
          <div><video></video></div>
          <div><h1>More clips soon</h1></div>
        </article>
        <article>
          ${header('fixture.brand', '/p/AD001/', '<div><span>Sponsored</span></div>')}
          <div><h1>Fixture sale</h1></div>
        </article>
      </main>`, (page) => page.run(readInstagramPosts, DOM_READ_DEFAULTS));
      expect(posts).toEqual([
        post({
          key: `${ORIGIN}/p/C0DE1/`, url: `${ORIGIN}/p/C0DE1/`, author: 'fixture.eats', text: 'Omakase night at a fixture counter',
          time: '2026-10-18T12:00:00.000Z', images: [{ url: photo, alt: 'Photo of a sushi counter' }],
        }),
        post({ key: `${ORIGIN}/reel/R33L1/`, url: `${ORIGIN}/reel/R33L1/`, author: 'fixture.clips', text: 'More clips soon', time: '2026-10-18T12:00:00.000Z', video: true }),
        post({ key: `${ORIGIN}/p/AD001/`, url: `${ORIGIN}/p/AD001/`, author: 'fixture.brand', text: 'Fixture sale', time: '2026-10-18T12:00:00.000Z', ad: true }),
      ]);
    });
  });

  describe('readFacebookPosts and expandFacebookPosts', () => {
    const FEED = (photo1: string, photo2: string) => `
      <div role="feed">
        <div><div aria-posinset="1" aria-setsize="-1">
          <div data-ad-rendering-role="profile_name"><h2><strong><a href="${ORIGIN}/fixture.page?__cft__[0]=AZ1&amp;__tn__=-UC">Fixture Page</a></strong></h2></div>
          <div><a href="${ORIGIN}/fixture.page/posts/pfbid0001?__cft__[0]=AZ1&amp;__tn__=%2CO%2CP-R"><span>3h</span></a></div>
          <div data-ad-rendering-role="story_message"><div dir="auto">The first lines of a long post<div role="button" tabindex="0">See more</div></div></div>
          <div><a href="${ORIGIN}/photo/?fbid=111&amp;set=a.9&amp;__cft__[0]=AZ1"><img src="${photo1}" width="500" height="300" alt="May be an image of noodles"></a></div>
        </div></div>
        <div><div aria-posinset="2" aria-setsize="-1">
          <h3><a href="${ORIGIN}/fixture.other">Fixture Other</a></h3>
          <div><a href="${ORIGIN}/photo/?fbid=222&amp;set=a.9&amp;__cft__[0]=AZ2"><span>5h</span></a></div>
          <div data-ad-rendering-role="story_message"><div dir="auto">A photo post</div></div>
          <img src="${photo2}" width="500" height="300" alt="">
        </div></div>
        <div><div aria-posinset="3" aria-setsize="-1">
          <h3><a href="${ORIGIN}/fixture.brand">Fixture Brand</a></h3>
          <div data-ad-rendering-role="meta"><span>Sponsored</span></div>
          <div data-ad-rendering-role="story_message"><div dir="auto">Fixture gloves on sale</div></div>
        </div></div>
        <div><div aria-posinset="4" aria-setsize="-1">
          <h3><a href="${ORIGIN}/fixture.page">Fixture Page</a></h3>
          <div><a href="${ORIGIN}/fixture.page/videos/987/"><span>1d</span></a></div>
          <div data-ad-rendering-role="story_message"><div dir="auto">Our new video</div></div>
          <video></video>
        </div></div>
      </div>
      <script>
        for (const b of document.querySelectorAll('[role="button"]')) {
          if (b.textContent === 'See more') b.addEventListener('click', () => { b.closest('[dir="auto"]').textContent = 'The first lines of a long post and the rest of it, shown once expanded.'; });
        }
      </script>`;

    it('reads the feed: author, link without tracking, text, photos, ads and videos; expanding shows the whole text', async () => {
      const photo1 = server.put('/scontent/photo1.png', solidPng(500, 300), 'image/png');
      const photo2 = server.put('/scontent/photo2.png', solidPng(500, 300), 'image/png');
      const { before, clicked, after } = await onPage(FEED(photo1, photo2), async (page) => ({
        before: await page.run(readFacebookPosts, DOM_READ_DEFAULTS),
        clicked: await page.run(expandFacebookPosts, undefined),
        after: await page.run(readFacebookPosts, DOM_READ_DEFAULTS),
      }));
      expect(before[0]).toMatchObject({ text: 'The first lines of a long post\nSee more', truncated: true });
      expect(clicked).toBe(1);
      expect(after).toEqual([
        post({
          key: `${ORIGIN}/fixture.page/posts/pfbid0001`, url: `${ORIGIN}/fixture.page/posts/pfbid0001`, author: 'Fixture Page',
          text: 'The first lines of a long post and the rest of it, shown once expanded.', images: [{ url: photo1, alt: 'May be an image of noodles' }],
        }),
        post({ key: `${ORIGIN}/photo/?fbid=222&set=a.9`, url: `${ORIGIN}/photo/?fbid=222&set=a.9`, author: 'Fixture Other', text: 'A photo post', images: [{ url: photo2, alt: '' }] }),
        post({ key: 'Fixture Brand:Fixture gloves on sale', author: 'Fixture Brand', text: 'Fixture gloves on sale', ad: true }),
        post({ key: `${ORIGIN}/fixture.page/videos/987/`, url: `${ORIGIN}/fixture.page/videos/987/`, author: 'Fixture Page', text: 'Our new video', video: true }),
      ]);
    });
  });

  describe('Rednote', () => {
    const NOTE_A = '64f0000000000000000000a1';
    const NOTE_B = '64f0000000000000000000a2';
    const NOTE_C = '64f0000000000000000000b1';
    /** A Vue ref as the page state serializes it. */
    const ref = (value: unknown) => ({ __v_isShallow: false, __v_isRef: true, _rawValue: value, _value: value });

    it('reads the cards in the page state through its refs; entries that are not notes are left out', async () => {
      const state = {
        feed: {
          feeds: ref([
            { id: NOTE_A, modelType: 'note', xsecToken: 'XT1', noteCard: { type: 'normal', displayTitle: 'Fixture noodle notes', user: { nickname: 'fixture eater' }, interactInfo: { likedCount: '1.2k' }, cover: { urlDefault: `${ORIGIN}/cover/a.webp` } } },
            { id: NOTE_B, modelType: 'note', xsecToken: 'XT2', noteCard: { type: 'video', displayTitle: 'Fixture video', user: { nickName: 'fixture filmer' }, interactInfo: { likedCount: '88' }, cover: { url: `${ORIGIN}/cover/b.webp` } } },
            { id: 'hot-1', modelType: 'hot_query', hotQuery: { queries: [] } },
          ]),
        },
        search: { feeds: ref([]) },
        user: { notes: ref([[{ id: NOTE_C, noteCard: ref({ xsecToken: 'XT3', displayTitle: 'Profile note', type: 'normal', user: { nickname: 'fixture owner' }, interactInfo: { likedCount: '5' }, cover: { urlDefault: `${ORIGIN}/cover/c.webp` } }) }], []]) },
      };
      const cards = await onPage(`<div id="app"></div>${pageData('__INITIAL_STATE__', state)}`, (page) => page.run(readRednoteCards, undefined));
      expect(cards).toEqual([
        { id: NOTE_A, xsecToken: 'XT1', title: 'Fixture noodle notes', author: 'fixture eater', likes: '1.2k', cover: `${ORIGIN}/cover/a.webp`, video: false },
        { id: NOTE_B, xsecToken: 'XT2', title: 'Fixture video', author: 'fixture filmer', likes: '88', cover: `${ORIGIN}/cover/b.webp`, video: true },
        { id: NOTE_C, xsecToken: 'XT3', title: 'Profile note', author: 'fixture owner', likes: '5', cover: `${ORIGIN}/cover/c.webp`, video: false },
      ]);
    });

    it('reads the cards from the page when the state holds none', async () => {
      const cover = img('rednote-cover', 240, 320);
      const card = (id: string, title: string, video: boolean) => `
        <section class="note-item"><div>
          <a class="cover" href="/explore/${id}?xsec_token=XT-${id.slice(-2)}&amp;xsec_source=pc_feed"><img src="${cover}" width="240" height="320">${video ? '<span class="play-icon"></span>' : ''}</a>
          <div class="footer"><a class="title"><span>${title}</span></a>
            <div class="card-bottom-wrapper"><a class="author"><span class="name">fixture author</span></a><span class="like-wrapper"><span class="count">42</span></span></div>
          </div>
        </div></section>`;
      const cards = await onPage(`<div class="feeds-container">${card(NOTE_A, 'Card title', false)}${card(NOTE_B, 'Video card', true)}</div>`, (page) => page.run(readRednoteCards, undefined));
      expect(cards).toEqual([
        { id: NOTE_A, xsecToken: 'XT-a1', title: 'Card title', author: 'fixture author', likes: '42', cover, video: false },
        { id: NOTE_B, xsecToken: 'XT-a2', title: 'Video card', author: 'fixture author', likes: '42', cover, video: true },
      ]);
    });

    it('reads a note page from its state, and from the page without one', async () => {
      const state = {
        note: {
          noteDetailMap: ref({
            [NOTE_A]: { note: {
              title: 'Fixture noodle notes', desc: 'Three bowls, one winner.', type: 'normal', time: 1792634400000,
              user: { nickname: 'fixture eater' }, interactInfo: { likedCount: '1.2k', collectedCount: '300', commentCount: '45' },
              imageList: [{ urlDefault: `${ORIGIN}/note/1.webp` }, ref({ url: `${ORIGIN}/note/2.webp` })], tagList: [{ name: 'noodles' }, { name: 'fixture' }],
            } },
          }),
        },
      };
      const fromState = await onPage(`<div id="app"></div>${pageData('__INITIAL_STATE__', state)}`, (page) => page.run(readRednoteNote, NOTE_A), `/explore/${NOTE_A}`);
      expect(fromState).toEqual({
        title: 'Fixture noodle notes', text: 'Three bowls, one winner.', author: 'fixture eater', time: new Date(1792634400000).toISOString(),
        images: [`${ORIGIN}/note/1.webp`, `${ORIGIN}/note/2.webp`], video: false,
        stats: [['likes', '1.2k'], ['saves', '300'], ['comments', '45']], tags: ['noodles', 'fixture'],
      });

      const slide = img('rednote-slide', 400, 500);
      const fromPage = await onPage(`<div id="noteContainer">
        <div class="media-container"><div class="swiper-slide"><img src="${slide}"></div><div class="swiper-slide"><img src="${slide}"></div></div>
        <div class="author-wrapper"><span class="username">fixture eater</span></div>
        <div class="note-content"><div id="detail-title">Page title</div><div id="detail-desc">Page text</div></div>
      </div>`, (page) => page.run(readRednoteNote, NOTE_A), `/explore/${NOTE_A}`);
      expect(fromPage).toEqual({ title: 'Page title', text: 'Page text', author: 'fixture eater', time: '', images: [slide], video: false, stats: [], tags: [] });
    });

    it('tells a captcha, a login page and an error page from a listing', async () => {
      const at = (path: string) => onPage('<div></div>', (page) => page.run(rednoteBlocked, undefined), path);
      expect(await at('/website-login/captcha?redirectPath=%2Fexplore&verifyType=102')).toEqual({ kind: 'captcha', detail: '' });
      expect(await at('/login?redirectPath=%2Fexplore')).toEqual({ kind: 'login', detail: '' });
      expect(await at('/website-login/error?error_code=300031&error_msg=fixture%20message')).toEqual({ kind: 'blocked', detail: 'fixture message' });
      expect(await at('/explore')).toBeNull();
    });
  });

  describe('readGenericPosts', () => {
    it('reads the outermost articles with their link, time and images, leaving avatars out', async () => {
      const avatar = img('generic-avatar', 200, 200);
      const photo = img('generic-photo', 400, 300);
      const posts = await onPage(`<main>
        <article>
          <header><img class="avatar" alt="fixture writer" src="${avatar}" width="200" height="200"><a href="/u/fixture">fixture writer</a></header>
          <p>A generic post about fixture gardens.</p>
          <img alt="A garden" src="${photo}" width="400" height="300">
          <a href="/posts/42"><time datetime="2026-10-20T09:00:00Z">2 days ago</time></a>
          <button>Reply</button>
          <article><p>A nested reply</p></article>
        </article>
        <article><p>Ad blockers are the topic of this post.</p><a href="/posts/43">Open</a></article>
        <article><div><span>Sponsored</span></div><p>Buy fixture gloves</p></article>
        <div role="article"><p>Role article text</p><a href="/p/abc">Open</a></div>
      </main>`, (page) => page.run(readGenericPosts, DOM_READ_DEFAULTS));
      expect(posts).toEqual([
        post({
          key: `${ORIGIN}/posts/42`, url: `${ORIGIN}/posts/42`, text: 'fixture writer\nA generic post about fixture gardens.\n2 days ago\nA nested reply',
          time: '2026-10-20T09:00:00Z', images: [{ url: photo, alt: 'A garden' }],
        }),
        post({ key: `${ORIGIN}/posts/43`, url: `${ORIGIN}/posts/43`, text: 'Ad blockers are the topic of this post.\nOpen' }),
        post({ key: 'Sponsored\nBuy fixture gloves', text: 'Sponsored\nBuy fixture gloves', ad: true }),
        post({ key: `${ORIGIN}/p/abc`, url: `${ORIGIN}/p/abc`, text: 'Role article text\nOpen' }),
      ]);
    });

    it('finds posts around their times when the page has no articles', async () => {
      const posts = await onPage(`<div class="feed">
        <div class="item"><div class="meta"><span>fixture poster</span> <time datetime="2026-10-21T08:00:00Z">yesterday</time></div>
          <div class="body">A post without semantic markup, long enough to pass the eighty character mark easily.</div><a href="/status/77">Open</a></div>
        <div class="item"><div class="meta"><time datetime="2026-10-21T07:00:00Z">yesterday</time></div>
          <div class="body">Another post without semantic markup, also comfortably longer than eighty characters.</div></div>
      </div>`, (page) => page.run(readGenericPosts, DOM_READ_DEFAULTS));
      expect(posts.map((p) => [p.url, p.time])).toEqual([[`${ORIGIN}/status/77`, '2026-10-21T08:00:00Z'], ['', '2026-10-21T07:00:00Z']]);
      expect(posts[0]!.text).toContain('A post without semantic markup');
      expect(posts[1]!.text).toContain('Another post without semantic markup');
    });
  });
});
