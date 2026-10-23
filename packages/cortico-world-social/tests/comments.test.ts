/**
 * Comments and Notes: the store of drafts, the queue, what was posted, the inbox watch and the day's
 * plan of Notes, with the daily counts; what counts as a link, what a Reddit link replies to, posting
 * through Reddit's comment endpoint, and the replies read from the inbox, on a scripted page.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchedText } from '../src/browser.ts';
import { PlatformBlocked } from '../src/collect.ts';
import { CommentRefused, CommentStore, POSTED_KEPT, SEEN_KEPT, hasLink } from '../src/comments.ts';
import { parseRedditInbox } from '../src/platforms/reddit-parse.ts';
import { postRedditComment, redditInbox, redditReplyTarget } from '../src/platforms/reddit.ts';
import { ScriptedBrowser, json, type FetchInit } from './helpers/scripted-browser.ts';

const TZ = 'Asia/Singapore';
const REDDIT = 'https://www.reddit.com';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'social-comments-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'social-comments.json');
}

const reply = (url: string) => ({ platform: 'reddit' as const, kind: 'comment' as const, url, target: 't3_abc123', text: `Reply to ${url}` });
const note = (text: string) => ({ platform: 'substack' as const, kind: 'note' as const, url: '', target: '', text });
/** What a posted comment records, besides the fields a case sets. */
const sent = { platform: 'reddit' as const, kind: 'comment' as const, link: null, edited: false, auto: false };

describe('the comment store', () => {
  it('keeps drafts and posted comments across restarts, and never gives a draft id twice', () => {
    const file = storeFile();
    const now = Date.parse('2026-10-23T02:00:00Z');
    const first = new CommentStore(file, () => now);
    const one = first.add(reply('one'));
    const two = first.add(reply('two'));
    first.record({ ...sent, url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true }, one.id);
    const again = new CommentStore(file, () => now);
    expect(again.drafts()).toEqual([two]);
    expect(again.posted()).toEqual([{ ...sent, url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true, at: new Date(now).toISOString() }]);
    expect([one.id, two.id]).not.toContain(again.add(reply('three')).id);
  });

  it('counts the comments posted on the local date only', () => {
    // Asia/Singapore is eight hours ahead of UTC: 15:59 UTC is 23:59 there, 16:01 UTC the next day
    let now = Date.parse('2026-10-22T15:59:00Z');
    const store = new CommentStore(storeFile(), () => now);
    for (const url of ['one', 'two']) store.record({ ...sent, url, text: url }, store.add(reply(url)).id);
    expect(store.today(TZ)).toBe(2);
    now = Date.parse('2026-10-22T16:01:00Z');
    expect(store.today(TZ)).toBe(0);
  });

  it(`keeps the last ${POSTED_KEPT} posted comments, newest first`, () => {
    const store = new CommentStore(storeFile());
    for (let i = 0; i < POSTED_KEPT + 3; i++) store.record({ ...sent, url: `post ${i}`, text: `comment ${i}` });
    const posted = store.posted();
    expect(posted).toHaveLength(POSTED_KEPT);
    expect(posted[0]!.text).toBe(`comment ${POSTED_KEPT + 2}`);
    expect(posted.at(-1)!.text).toBe('comment 3');
    expect(store.posted(2).map((p) => p.text)).toEqual([`comment ${POSTED_KEPT + 2}`, `comment ${POSTED_KEPT + 1}`]);
  });

  it('lists comments and Notes apart, and counts each kind against its own daily limit', () => {
    const store = new CommentStore(storeFile(), () => Date.parse('2026-10-23T02:00:00Z'));
    store.record({ ...sent, url: 'one', text: 'a comment' });
    store.record({ ...sent, ...note('a Note'), link: 'https://substack.com/@fixturewriter/note/c-101' });
    expect(store.posted(10, 'comment').map((p) => p.text)).toEqual(['a comment']);
    expect(store.posted(10, 'note').map((p) => p.text)).toEqual(['a Note']);
    expect([store.today(TZ), store.today(TZ, 'note')]).toEqual([1, 1]);
  });

  it('reads a draft or a posted comment saved without a kind as a comment', () => {
    const file = storeFile();
    writeFileSync(file, JSON.stringify({
      next: 3,
      drafts: [{ id: 'c2', platform: 'reddit', url: 'u', target: 't3_abc123', text: 'x', at: '2026-10-22T01:00:00.000Z' }],
      posted: [{ platform: 'reddit', url: 'u', link: null, text: 'y', edited: false, auto: false, at: '2026-10-22T01:00:00.000Z' }],
    }));
    const store = new CommentStore(file);
    expect(store.drafts().map((d) => d.kind)).toEqual(['comment']);
    expect(store.posted().map((p) => p.kind)).toEqual(['comment']);
    expect(store.queued()).toEqual([]);
  });

  it('starts empty from a file it cannot read, keeping that file beside it', () => {
    const file = storeFile();
    writeFileSync(file, '{"drafts": [');
    const store = new CommentStore(file);
    expect(store.drafts()).toEqual([]);
    expect(store.posted()).toEqual([]);
    expect(existsSync(`${file}.unreadable`)).toBe(true);
  });
});

describe('the queue of automatic posts', () => {
  it('gives them out in the order they are due, across restarts, with ids no draft shares', () => {
    const file = storeFile();
    const store = new CommentStore(file, () => Date.parse('2026-10-23T02:00:00Z'));
    const draft = store.add(reply('d'));
    const late = store.enqueue({ ...reply('late'), due: '2026-10-23T02:30:00.000Z' });
    const soon = store.enqueue({ ...note('soon'), due: '2026-10-23T02:05:00.000Z' });
    const again = new CommentStore(file);
    expect(again.queued().map((q) => q.id)).toEqual([soon.id, late.id]);
    expect(new Set([draft.id, late.id, soon.id]).size).toBe(3);
    expect(again.unqueue(soon.id)?.text).toBe('soon');
    expect(again.unqueue(soon.id)).toBeUndefined();
    expect(again.queued().map((q) => q.id)).toEqual([late.id]);
  });

  it('records a queued post that went out and takes it off the queue', () => {
    const store = new CommentStore(storeFile());
    const q = store.enqueue({ ...reply('u'), due: '2026-10-23T02:05:00.000Z' });
    store.record({ ...sent, url: 'u', text: q.text, auto: true }, q.id);
    expect(store.queued()).toEqual([]);
    expect(store.posted().map((p) => p.text)).toEqual([q.text]);
  });

  it('spaces from the last post of a kind on a platform, posted or queued', () => {
    let now = Date.parse('2026-10-23T02:00:00Z');
    const store = new CommentStore(storeFile(), () => now);
    expect(store.lastAt('reddit', 'comment')).toBe(0);
    store.record({ ...sent, url: 'u', text: 'x' });
    expect(store.lastAt('reddit', 'comment')).toBe(now);
    now += 60_000;
    store.enqueue({ ...reply('u'), due: '2026-10-23T03:00:00.000Z' });
    expect(store.lastAt('reddit', 'comment')).toBe(Date.parse('2026-10-23T03:00:00.000Z'));
    expect([store.lastAt('substack', 'note'), store.lastAt('substack', 'comment')]).toEqual([0, 0]);
  });

  it('counts queued posts due today against the day, and those due tomorrow against tomorrow', () => {
    const store = new CommentStore(storeFile(), () => Date.parse('2026-10-22T15:00:00Z'));
    store.enqueue({ ...note('tonight'), due: '2026-10-22T15:50:00.000Z' });
    // 16:10 UTC is past midnight in Asia/Singapore
    store.enqueue({ ...note('after midnight'), due: '2026-10-22T16:10:00.000Z' });
    expect(store.todayWithQueued(TZ, 'note')).toBe(1);
    expect(store.todayWithQueued(TZ, 'comment')).toBe(0);
  });
});

describe("the day's plan of Notes", () => {
  it('keeps one plan a day across restarts, and how many of it were asked for', () => {
    const file = storeFile();
    const store = new CommentStore(file);
    let picks = 0;
    const pick = () => { picks++; return [600, 900]; };
    expect(store.plan('2026-10-23', 2, pick)).toEqual({ date: '2026-10-23', times: [600, 900], told: 0 });
    store.told(1);
    expect(new CommentStore(file).plan('2026-10-23', 2, pick)).toEqual({ date: '2026-10-23', times: [600, 900], told: 1 });
    expect(picks).toBe(1);
  });

  it('plans again for another day, or when the number a day changed, keeping what that day already told', () => {
    const store = new CommentStore(storeFile());
    store.plan('2026-10-23', 2, () => [600, 900]);
    store.told(1);
    expect(store.plan('2026-10-23', 3, () => [600, 800, 1000])).toEqual({ date: '2026-10-23', times: [600, 800, 1000], told: 1 });
    expect(store.plan('2026-10-24', 3, () => [610, 810, 1010])).toEqual({ date: '2026-10-24', times: [610, 810, 1010], told: 0 });
  });
});

describe('what a Reddit link replies to', () => {
  it('is the comment the link names, else its post', () => {
    expect(redditReplyTarget(`${REDDIT}/r/fixture/comments/abc123/some_title/`)).toBe('t3_abc123');
    expect(redditReplyTarget('https://old.reddit.com/r/fixture/comments/abc123/some_title/def456/?context=3')).toBe('t1_def456');
    expect(redditReplyTarget(`${REDDIT}/r/fixture/comments/abc123/comment/def456/`)).toBe('t1_def456');
    expect(redditReplyTarget(`${REDDIT}/comments/abc123`)).toBe('t3_abc123');
    expect(redditReplyTarget('https://redd.it/abc123')).toBe('t3_abc123');
    expect(redditReplyTarget(`${REDDIT}/gallery/abc123`)).toBe('t3_abc123');
  });

  it('is null for a share link, a subreddit, another site, and a link that is no http(s) link', () => {
    for (const url of [`${REDDIT}/r/fixture/s/AbCdEf123`, `${REDDIT}/r/fixture/`, 'https://fixture.test/comments/abc123/x/', 'not a link', 'javascript://www.reddit.com/r/fixture/comments/abc123/x/%0Aalert(1)']) {
      expect(redditReplyTarget(url), url).toBeNull();
    }
  });
});

describe('posting a Reddit comment', () => {
  const ME = `${REDDIT}/api/me.json`;
  const COMMENT = `${REDDIT}/api/comment`;
  const posted = (data: Record<string, unknown>) => json({ json: { errors: [], data: { things: [{ kind: 't1', data }] } } });

  /** A browser logged in with `modhash` (none: logged out), answering the comment endpoint with `answer`. */
  function reddit(modhash: string | null, answer: FetchedText) {
    const sent: NonNullable<FetchInit>[] = [];
    const browser = new ScriptedBrowser({
      fetch: (url, init) => {
        if (url === ME) return json(modhash ? { kind: 't2', data: { name: 'fixture_alice', modhash } } : {});
        if (url !== COMMENT) return undefined;
        sent.push(init ?? {});
        return answer;
      },
    });
    const post = (target: string, text: string) => browser.withPage((page) => postRedditComment(page, target, text), { timeLeft: () => 30_000 });
    return { post, sent };
  }

  it("sends the comment with the login's modhash and returns the comment's link", async () => {
    const { post, sent } = reddit('fixturehash', posted({ id: 'def456', link_id: 't3_abc123', permalink: '/r/fixture/comments/abc123/x/def456/' }));
    expect(await post('t3_abc123', 'Line one\n\n**bold**')).toEqual({ link: `${REDDIT}/r/fixture/comments/abc123/x/def456/` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', 'x-modhash': 'fixturehash' });
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ api_type: 'json', raw_json: '1', thing_id: 't3_abc123', text: 'Line one\n\n**bold**' });
  });

  it('builds the link from the comment and post ids when Reddit gives no permalink, and gives none without them', async () => {
    expect(await reddit('h', posted({ id: 'def456', link_id: 't3_abc123' })).post('t1_xyz', 'x')).toEqual({ link: `${REDDIT}/comments/abc123/_/def456/` });
    expect(await reddit('h', json({ json: { errors: [] } })).post('t1_xyz', 'x')).toEqual({ link: null });
  });

  it('asks for a login when the browser has none, without sending the comment', async () => {
    const { post, sent } = reddit(null, posted({ id: 'def456' }));
    const err = await post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformBlocked);
    expect((err as PlatformBlocked).kind).toBe('login');
    expect(sent).toEqual([]);
  });

  it("gives Reddit's reasons when it turns the comment down", async () => {
    const err = await reddit('h', json({ json: { errors: [['RATELIMIT', 'Take a break for 5 minutes.', 'ratelimit'], ['TOO_LONG', 'This is too long.', 'text']] } }))
      .post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommentRefused);
    expect(err).toMatchObject({ platform: 'reddit', detail: 'RATELIMIT: Take a break for 5 minutes.; TOO_LONG: This is too long.' });
  });

  it('names a refusal by its HTTP status, and takes 429 as a block and 401 as a missing login', async () => {
    const forbidden = await reddit('h', { status: 403, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(CommentRefused);
    expect((forbidden as CommentRefused).detail).toBe('HTTP 403');
    const limited = await reddit('h', { status: 429, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(limited).toMatchObject({ kind: 'blocked' });
    const loggedOut = await reddit('h', { status: 401, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(loggedOut).toMatchObject({ kind: 'login' });
  });
});

describe('the inbox watch', () => {
  it('starts on the first look after automatic replies are turned on, and again after they were off', () => {
    const file = storeFile();
    let now = Date.parse('2026-10-23T02:00:00Z');
    const store = new CommentStore(file, () => now);
    const first = store.watchSince();
    now += 60_000;
    expect(store.watchSince()).toBe(first);
    expect(new CommentStore(file, () => now).watchSince()).toBe(first);
    store.stopWatching();
    expect(store.watchSince()).toBe(new Date(now).toISOString());
  });

  it(`remembers the last ${SEEN_KEPT} replies looked at, across restarts, with the time of the look`, () => {
    const file = storeFile();
    const now = Date.parse('2026-10-23T02:00:00Z');
    const store = new CommentStore(file, () => now);
    store.looked(Array.from({ length: SEEN_KEPT + 5 }, (_, i) => `t1_r${i}`));
    const again = new CommentStore(file, () => now);
    expect(again.seen('t1_r0')).toBe(false);
    expect(again.seen(`t1_r${SEEN_KEPT + 4}`)).toBe(true);
    expect(again.checkedAt).toBe(new Date(now).toISOString());
  });

  it('counts the automatic answers to one account today, whatever its letter case', () => {
    const store = new CommentStore(storeFile());
    const answer = (to: string) => store.record({ ...sent, url: 'u', text: 'x', auto: true, to });
    answer('fixture_bob');
    answer('Fixture_Bob');
    answer('fixture_carol');
    store.record({ ...sent, url: 'u', text: 'x', auto: true });
    store.enqueue({ ...reply('u'), to: 'fixture_bob', due: new Date().toISOString() });
    expect(store.answeredToday('FIXTURE_BOB', TZ)).toBe(3);
    expect(store.answeredToday('fixture_dan', TZ)).toBe(0);
  });
});

describe('what counts as a link', () => {
  it('is a web address, a Markdown link or a host on a common domain ending', () => {
    for (const text of ['see https://fixture.test/x', 'www.fixture.test', '[menu](/r/x)', 'go to fixture-shop.com now', 'FIXTURE.IO']) expect(hasLink(text), text).toBe(true);
  });

  it('is not a sentence with dots, an abbreviation or a subreddit', () => {
    for (const text of ['Go early. It fills up.', 'e.g. the U.S. branch', 'r/fixturetown has more', 'node.js and 3.5 stars']) expect(hasLink(text), text).toBe(false);
  });
});

describe('the replies in the inbox', () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    kind: 't1',
    data: { id, author: 'fixture_bob', body: `Reply  ${id}`, link_title: 'Fixture title', context: `/r/fixture/comments/abc123/x/${id}/?context=3`, created_utc: 1792634400, type: 'comment_reply', was_comment: true, ...over },
  });

  it('are the replies to comments and to posts, linked without the context query', () => {
    const replies = parseRedditInbox({
      kind: 'Listing',
      data: { children: [item('k1'), item('k2', { type: 'post_reply' }), item('k3', { type: 'username_mention' }), { kind: 't4', data: { id: 'm1', author: 'fixture_bob', body: 'A message', was_comment: false } }, item('k4', { context: '' })] },
    });
    expect(replies).toEqual([
      { target: 't1_k1', url: `${REDDIT}/r/fixture/comments/abc123/x/k1/`, author: 'fixture_bob', text: 'Reply k1', title: 'Fixture title', createdAtMs: 1792634400_000 },
      { target: 't1_k2', url: `${REDDIT}/r/fixture/comments/abc123/x/k2/`, author: 'fixture_bob', text: 'Reply k2', title: 'Fixture title', createdAtMs: 1792634400_000 },
    ]);
  });

  it('are read with the account logged in, without marking them read, and ask for a login without one', async () => {
    const asked: string[] = [];
    const page = (me: unknown) => new ScriptedBrowser({
      fetch: (url) => {
        asked.push(url);
        if (url === `${REDDIT}/api/me.json`) return json(me);
        return json({ kind: 'Listing', data: { children: [item('k1')] } });
      },
    });
    const read = (b: ScriptedBrowser) => b.withPage((p) => redditInbox(p), { timeLeft: () => 30_000 });
    const inbox = await read(page({ kind: 't2', data: { name: 'fixture_alice' } }));
    expect(inbox.me).toBe('fixture_alice');
    expect(inbox.replies.map((r) => r.target)).toEqual(['t1_k1']);
    expect(new URL(asked.find((u) => u.includes('/message/'))!).searchParams.get('mark')).toBe('false');
    await expect(read(page({}))).rejects.toMatchObject({ kind: 'login' });
  });
});
