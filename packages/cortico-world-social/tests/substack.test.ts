/**
 * Substack: its JSON read into posts (`substack-parse.ts`), what a query or link names, the listings,
 * reads and writes of `platforms/substack.ts` on a scripted page, every answer shaped like Substack's
 * own but made up.
 */
import { describe, expect, it } from 'vitest';
import type { FetchedText, PageSession } from '../src/browser.ts';
import { Collector, Deadline, PlatformBlocked } from '../src/collect.ts';
import { CommentRefused } from '../src/comments.ts';
import {
  findCategory, htmlText, markdownDoc, noteDoc, parseSubstackArchive, parseSubstackCategories, parseSubstackComments, parseSubstackFeed,
  parseSubstackLeaderboard, profileHandle, publicationAddress,
} from '../src/platforms/substack-parse.ts';
import { SUBSTACK, createSubstackDraft, postSubstackComment, postSubstackNote, substackNoteId, substackPostRef } from '../src/platforms/substack.ts';
import type { BrowseRequest } from '../src/platforms/index.ts';
import { ScriptedBrowser, json, type FetchInit } from './helpers/scripted-browser.ts';

const SUBSTACK_COM = 'https://substack.com';
const PUB = 'https://fixturewriter.substack.com';
/** The own domain fixturewriter.substack.com leads to, as a publication with one does. */
const OWN = 'https://www.fixture-weekly.test';

const article = (id: number, over: Record<string, unknown> = {}) => ({
  id, slug: `post-${id}`, title: `Fixture post ${id}`, subtitle: `Subtitle ${id}`, canonical_url: `${OWN}/p/post-${id}`, post_date: '2026-10-20T08:00:00.000Z',
  reaction_count: 10 * id, comment_count: id, restacks: 1, type: 'newsletter', audience: 'everyone', truncated_body_text: `The start of post ${id}.`,
  description: `Subtitle ${id}`, publishedBylines: [{ id: 7001, name: 'Fixture Writer', handle: 'fixturewriter' }], videoUpload: null, podcast_url: null, ...over,
});
const noteItem = (id: number, body: string, handle = 'fixturewriter') => ({
  type: 'comment', entity_key: `c-${id}`,
  comment: { id, name: 'Fixture Writer', handle, body, date: '2026-10-21T09:00:00.000Z', reaction_count: 5, children_count: 2, restacks: 1 },
  context: { type: 'note', users: [{ name: 'Fixture Writer', handle }] },
});
const postItem = (id: number) => ({
  type: 'post', entity_key: `p-${id}`, post: article(id), publication: { name: 'Fixture Weekly', subdomain: 'fixturewriter', custom_domain: 'www.fixture-weekly.test' },
  context: { type: 'post', users: [] },
});

describe('Substack JSON', () => {
  it("reads a post's HTML as lines, without scripts, with its entities decoded", () => {
    const html = '<h2>Head &amp; line</h2><p>One<br>two &#8212; &#x2014; &bogus;</p><script>x()</script><ul><li>a</li><li>b</li></ul>';
    expect(htmlText(html)).toBe('Head & line\nOne\ntwo — — &bogus;\n- a\n- b');
  });

  it("reads an archive's posts with their start, author and counts, linked at the address given", () => {
    const [post, podcast] = parseSubstackArchive([article(1), article(2, { type: 'podcast' }), { title: 'no id or slug' }], PUB);
    expect(post).toEqual({
      platform: 'substack', id: '1', url: `${PUB}/p/post-1`, author: 'Fixture Writer', title: 'Fixture post 1', text: 'Subtitle 1\nThe start of post 1.',
      publishedAt: '2026-10-20T08:00:00.000Z', stats: [['likes', '10'], ['comments', '1'], ['restacks', '1']], images: [], video: false, extraction: 'adapter',
    });
    expect(podcast!.video).toBe(true);
  });

  it('reads a feed as Notes and posts, a post linked at its substack.com address', () => {
    const posts = parseSubstackFeed({ items: [noteItem(101, 'A fixture Note.'), postItem(3), { type: 'comment', entity_key: 'c-102', comment: { id: 102 } }, { type: 'ad' }] });
    expect(posts.map((p) => [p.id, p.url, p.text])).toEqual([
      ['c-101', `${SUBSTACK_COM}/@fixturewriter/note/c-101`, 'A fixture Note.'],
      ['3', `${PUB}/p/post-3`, 'Subtitle 3\nThe start of post 3.'],
    ]);
    expect(posts[0]!.stats).toEqual([['likes', '5'], ['replies', '2'], ['restacks', '1']]);
    expect(posts[1]!.community).toBe('Fixture Weekly');
  });

  it("reads a post's top-level comments, in order, without the deleted, up to the number asked", () => {
    const comments = { comments: [
      { name: 'Fixture Reader', body: 'First.', reaction_count: 3, children: [{ body: 'A reply.' }] },
      { name: 'Gone', body: 'x', deleted: true },
      { handle: 'fixturereader2', body: 'Second.', reactions: { '❤': 2 } },
      { name: 'Third', body: 'Third.' },
    ] };
    expect(parseSubstackComments(comments, 2)).toEqual([
      { author: 'Fixture Reader', text: 'First.', score: '3 likes' },
      { author: 'fixturereader2', text: 'Second.', score: '2 likes' },
    ]);
  });

  it("reads a leaderboard's publications in order, at their substack.com addresses", () => {
    const board = { items: [
      { publication: { name: 'Fixture Weekly', subdomain: 'fixturewriter', custom_domain: 'www.fixture-weekly.test' }, user: {} },
      { publication: { name: 'Own Domain Only', custom_domain: 'https://fixture-daily.test/' } },
      { user: {} },
    ], more: true };
    expect(parseSubstackLeaderboard(board)).toEqual([{ origin: PUB, name: 'Fixture Weekly' }, { origin: 'https://fixture-daily.test', name: 'Own Domain Only' }]);
  });

  it('finds a category by its name or slug, whatever the case and punctuation, then by part of its name', () => {
    const categories = parseSubstackCategories([{ id: 4, name: 'Technology', slug: 'technology' }, { id: 13645, name: 'Food & Drink', slug: 'food' }, { id: 'podcast', name: 'Podcasts' }]);
    expect(categories.map((c) => c.id)).toEqual([4, 13645]);
    expect(findCategory(categories, 'food and drink')?.id).toBe(13645);
    expect(findCategory(categories, 'FOOD & drink')?.id).toBe(13645);
    expect(findCategory(categories, 'food')?.id).toBe(13645);
    expect(findCategory(categories, 'tech')?.id).toBe(4);
    expect(findCategory(categories, ' ')).toBeUndefined();
  });

  it("writes a Note as the editor's document: a line to a paragraph, a blank line to an empty one", () => {
    expect(noteDoc('One\n\nTwo')).toEqual({ type: 'doc', attrs: { schemaVersion: 'v1' }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }] }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
    ] });
  });

  it("writes a post's Markdown as the editor's document", () => {
    const doc = markdownDoc('# Title\n\nSome **bold**, *italic* and [a link](https://fixture.test/x).\n\n- one\n- two\n\n1. first\n\n> quoted\n> on');
    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Some ' }, { type: 'text', text: 'bold', marks: [{ type: 'strong' }] }, { type: 'text', text: ', ' },
        { type: 'text', text: 'italic', marks: [{ type: 'em' }] }, { type: 'text', text: ' and ' },
        { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://fixture.test/x' } }] }, { type: 'text', text: '.' },
      ] },
      { type: 'bullet_list', content: ['one', 'two'].map((x) => ({ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: x }] }] })) },
      { type: 'ordered_list', content: [{ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted on' }] }] },
    ]);
  });
});

describe('what a Substack query or link names', () => {
  it('names a publication by its name, its substack.com address, its own domain or a link into it', () => {
    expect(publicationAddress('fixturewriter')).toBe(PUB);
    expect(publicationAddress('fixturewriter.substack.com')).toBe(PUB);
    expect(publicationAddress(`${PUB}/p/post-1`)).toBe(PUB);
    expect(publicationAddress('www.fixture-weekly.test')).toBe(OWN);
  });

  it('names no publication for me, a person, a substack.com link, or what is no address', () => {
    for (const q of ['', 'me', 'ME', '@fixturewriter', `${SUBSTACK_COM}/@fixturewriter`, 'Fixture Weekly', 'javascript:alert(1)']) expect(publicationAddress(q), q).toBeNull();
  });

  it('names a person by @handle or a substack.com profile link', () => {
    expect(profileHandle('@fixturewriter')).toBe('fixturewriter');
    expect(profileHandle(`${SUBSTACK_COM}/@fixturewriter`)).toBe('fixturewriter');
    expect(profileHandle('substack.com/@fixturewriter/note/c-101')).toBe('fixturewriter');
    for (const q of ['me', 'fixturewriter', `${PUB}/@fixturewriter`, '@two words']) expect(profileHandle(q), q).toBeNull();
  });

  it('names a post by its /p/ link on substack.com, and a Note by its number', () => {
    expect(substackPostRef(`${PUB}/p/post-1?utm_source=x`)).toEqual({ origin: PUB, slug: 'post-1' });
    expect(substackPostRef(`${OWN}/p/post-1`)).toBeNull();
    expect(substackNoteId(`${SUBSTACK_COM}/@fixturewriter/note/c-101`)).toBe(101);
    expect(substackNoteId(`${PUB}/p/post-1`)).toBeNull();
  });
});

describe('Substack on a scripted page', () => {
  /** A scripted Substack where fixturewriter.substack.com leads to its own domain, with `answers` by URL; `sent` gets every write. */
  function substack(answers: Record<string, unknown>, write?: (url: string, body: unknown) => FetchedText | undefined) {
    const sent: Array<{ url: string; init: NonNullable<FetchInit> }> = [];
    const browser = new ScriptedBrowser({
      redirect: (url) => (url.startsWith(`${PUB}/`) ? OWN + url.slice(PUB.length) : undefined),
      fetch: (url, init) => {
        if (init?.method === 'POST') {
          sent.push({ url, init });
          return write?.(url, JSON.parse(init.body ?? 'null')) ?? json({ id: 555 });
        }
        if (url in answers) {
          const a = answers[url];
          return a && typeof a === 'object' && 'status' in a && 'text' in a ? a as FetchedText : json(a);
        }
        return undefined;
      },
    });
    const list = async (req: BrowseRequest, want = 10) => {
      const collector = new Collector('substack', want, 'ocr', new Deadline(60_000, browser.clock.read));
      await browser.withPage((page) => SUBSTACK.list(page, req, collector), { timeLeft: () => collector.deadline.leftMs });
      return collector.posts;
    };
    const on = <T>(fn: (page: PageSession) => Promise<T>) => browser.withPage(fn, { timeLeft: () => 30_000 });
    return { browser, list, on, sent };
  }

  const SELF = `${SUBSTACK_COM}/api/v1/user/profile/self`;
  const archive = (sort: string, offset = 0) => `${OWN}/api/v1/archive?sort=${sort}&offset=${offset}&limit=12`;

  it("lists a publication's posts from where its address led, linked at its substack.com address", async () => {
    const { list, browser } = substack({ [archive('new')]: [article(1), article(2)] });
    const posts = await list({ source: 'account', query: 'fixturewriter' });
    expect(posts.map((p) => p.url)).toEqual([`${PUB}/p/post-1`, `${PUB}/p/post-2`]);
    expect(browser.requests).toEqual([`${PUB}/robots.txt`, archive('new')]);
  });

  it('pages through an archive, most liked first with top, until enough are read', async () => {
    const page1 = Array.from({ length: 12 }, (_, i) => article(i + 1));
    const { list } = substack({ [archive('top')]: page1, [archive('top', 12)]: [article(13), article(14)] });
    expect((await list({ source: 'account', query: PUB, sort: 'top' }, 13)).map((p) => p.id).slice(-2)).toEqual(['12', '13']);
    expect(SUBSTACK.applied!({ source: 'account', query: PUB, sort: 'top' })).toEqual({ sort: 'top' });
  });

  it("lists the person's own Notes with me, which needs a login", async () => {
    const feed = `${SUBSTACK_COM}/api/v1/reader/feed/profile/7001`;
    const { list, browser } = substack({
      [SELF]: { id: 7001, handle: 'fixturewriter', name: 'Fixture Writer' },
      [`${feed}?types%5B%5D=note`]: { items: [noteItem(101, 'First Note.')], nextCursor: 'next page' },
      [`${feed}?types%5B%5D=note&cursor=next%20page`]: { items: [noteItem(102, 'Second Note.')] },
    });
    const posts = await list({ source: 'account', query: 'me', sort: 'notes' });
    expect(posts.map((p) => p.text)).toEqual(['First Note.', 'Second Note.']);
    expect(browser.requests.filter((u) => u.includes('/feed/'))).toHaveLength(2);
    expect(SUBSTACK.applied!({ source: 'account', query: 'me', sort: 'notes' })).toEqual({ sort: 'notes' });

    const loggedOut = substack({ [SELF]: { status: 401, text: '{"errors":[{"msg":"Please sign in"}]}' } });
    await expect(loggedOut.list({ source: 'account', query: 'me' })).rejects.toMatchObject({ kind: 'login' });
  });

  it("lists a person's Notes and posts by @handle, without a login", async () => {
    const { list } = substack({
      [`${SUBSTACK_COM}/api/v1/user/fixturereader/public_profile`]: { id: 8002, handle: 'fixturereader', name: 'Fixture Reader' },
      [`${SUBSTACK_COM}/api/v1/reader/feed/profile/8002`]: { items: [noteItem(201, 'A reader Note.', 'fixturereader'), postItem(4)] },
    });
    expect((await list({ source: 'account', query: '@fixturereader' })).map((p) => p.id)).toEqual(['c-201', '4']);
  });

  it('refuses an account query that names no publication or person', async () => {
    await expect(substack({}).list({ source: 'account', query: 'Fixture Weekly' })).rejects.toThrow(/names no Substack publication or person/);
  });

  it("lists a category's rising publications, each with its two most liked recent posts that are no videos", async () => {
    const other = 'https://fixtureother.substack.com';
    const { list, browser } = substack({
      [`${SUBSTACK_COM}/api/v1/categories`]: [{ id: 4, name: 'Technology', slug: 'technology' }],
      [`${SUBSTACK_COM}/api/v1/category/leaderboard/4/trending?page=0`]: { items: [
        { publication: { name: 'Fixture Weekly', subdomain: 'fixturewriter', custom_domain: 'www.fixture-weekly.test' } },
        { publication: { name: 'Busy Fixture', subdomain: 'fixturebusy' } },
        { publication: { name: 'Fixture Other', subdomain: 'fixtureother' } },
      ] },
      [archive('new')]: [article(1), article(3, { type: 'video' }), article(2), article(4, { reaction_count: 0 })],
      'https://fixturebusy.substack.com/api/v1/archive?sort=new&offset=0&limit=12': { status: 429, text: '' },
      [`${other}/api/v1/archive?sort=new&offset=0&limit=12`]: [article(9)],
    });
    const posts = await list({ source: 'community', query: 'technology' });
    expect(posts.map((p) => [p.community, p.url])).toEqual([
      ['Fixture Weekly', `${PUB}/p/post-2`], ['Fixture Weekly', `${PUB}/p/post-1`], ['Fixture Other', `${other}/p/post-9`],
    ]);
    expect(browser.requests).toContain('https://fixturebusy.substack.com/robots.txt');
    expect(SUBSTACK.applied!({ source: 'community', query: 'technology' })).toEqual({ sort: 'rising' });
  });

  it("reads the best-selling publications with paid, and names a category it doesn't know with some it does", async () => {
    const { list, browser } = substack({
      [`${SUBSTACK_COM}/api/v1/categories`]: [{ id: 4, name: 'Technology' }, { id: 96, name: 'Culture' }],
      [`${SUBSTACK_COM}/api/v1/category/leaderboard/4/paid?page=0`]: { items: [] },
    });
    expect(await list({ source: 'community', query: 'Technology', sort: 'paid' })).toEqual([]);
    expect(browser.requests).toContain(`${SUBSTACK_COM}/api/v1/category/leaderboard/4/paid?page=0`);
    await expect(list({ source: 'community', query: 'Knitting' })).rejects.toThrow('no Substack category is named "Knitting"; some are Technology, Culture');
  });

  it('reads a post with its comments, linked at the address the link named', async () => {
    const { on } = substack({
      [`${OWN}/api/v1/posts/post-5`]: article(5, { body_html: '<p>The whole post.</p>' }),
      [`${OWN}/api/v1/post/5/comments?all_comments=true&sort=best_first`]: { comments: [{ name: 'Fixture Reader', body: 'Nice.' }] },
    });
    const detail = await on((page) => SUBSTACK.read(page, `${PUB}/p/post-5`, 10, new Deadline(30_000)));
    expect(detail!.post).toMatchObject({ url: `${PUB}/p/post-5`, text: 'Subtitle 5\nThe whole post.' });
    expect(detail!.comments).toEqual([{ author: 'Fixture Reader', text: 'Nice.' }]);
    expect(await on((page) => SUBSTACK.read(page, `${PUB}/p/gone`, 10, new Deadline(30_000)))).toBeNull();
  });

  it('posts a Note, or a reply to one, as its document, and gives its link', async () => {
    const { on, sent } = substack({ [SELF]: { id: 7001, handle: 'fixturewriter', name: 'Fixture Writer' } }, () => json({ id: 301 }));
    expect(await on((page) => postSubstackNote(page, 'Line one\nLine two'))).toEqual({ link: `${SUBSTACK_COM}/@fixturewriter/note/c-301` });
    await on((page) => postSubstackNote(page, 'A reply.', 101));
    expect(sent.map((s) => s.url)).toEqual([`${SUBSTACK_COM}/api/v1/comment/feed`, `${SUBSTACK_COM}/api/v1/comment/feed`]);
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ bodyJson: noteDoc('Line one\nLine two'), replyMinimumRole: 'everyone', tabId: 'for-you', surface: 'feed' });
    expect(JSON.parse(sent[1]!.init.body!)).toMatchObject({ parent_id: 101 });
    expect(sent[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it("posts a comment on a post where its address led, and gives the comment's link", async () => {
    const { on, sent } = substack({ [`${OWN}/api/v1/posts/post-5`]: article(5) }, () => json({ id: 401 }));
    expect(await on((page) => postSubstackComment(page, `${PUB}/p/post-5`, 'Well put.'))).toEqual({ link: `${OWN}/p/post-5/comment/401` });
    expect(sent).toEqual([{ url: `${OWN}/api/v1/post/5/comment`, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Well put.' }) } }]);
  });

  it('creates a post draft by the account logged in, which nothing publishes, and gives its link in the editor', async () => {
    const { on, sent } = substack({ [SELF]: { id: 7001, handle: 'fixturewriter', name: 'Fixture Writer' } }, () => json({ id: 501 }));
    expect(await on((page) => createSubstackDraft(page, PUB, { title: 'Autumn walks', subtitle: '', body: 'One.\n\nTwo.' }))).toEqual({ link: `${OWN}/publish/post/501` });
    expect(sent.map((s) => s.url)).toEqual([`${OWN}/api/v1/drafts`]);
    const body = JSON.parse(sent[0]!.init.body!);
    expect(body).toMatchObject({ draft_title: 'Autumn walks', draft_bylines: [{ id: 7001, is_guest: false }], audience: 'everyone', type: 'newsletter' });
    expect(JSON.parse(body.draft_body)).toEqual(markdownDoc('One.\n\nTwo.'));
  });

  it("gives Substack's reason when it turns a write down, a block at 429, and a missing login at 401", async () => {
    const answer = (status: number, text = '') => substack({ [SELF]: { id: 7001, handle: 'fixturewriter', name: 'Fixture Writer' } }, () => ({ status, text }));
    const refused = await answer(400, '{"error":"Body too long"}').on((page) => postSubstackNote(page, 'x')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CommentRefused);
    expect(refused).toMatchObject({ platform: 'substack', detail: 'Body too long' });
    expect(await answer(500).on((page) => postSubstackNote(page, 'x')).catch((e: unknown) => e)).toMatchObject({ detail: 'HTTP 500' });
    expect(await answer(429).on((page) => postSubstackNote(page, 'x')).catch((e: unknown) => e)).toMatchObject({ kind: 'blocked' });
    const loggedOut = await answer(401).on((page) => postSubstackNote(page, 'x')).catch((e: unknown) => e);
    expect(loggedOut).toBeInstanceOf(PlatformBlocked);
    expect(loggedOut).toMatchObject({ kind: 'login' });
  });

  it('holds a login when Substack names the account, and none when it asks for a sign-in', async () => {
    expect(await substack({ [SELF]: { id: 7001, handle: 'fixturewriter' } }).on((page) => SUBSTACK.loggedIn!(page))).toBe(true);
    expect(await substack({ [SELF]: { status: 401, text: '{}' } }).on((page) => SUBSTACK.loggedIn!(page))).toBe(false);
  });
});
