/**
 * The platform writers without a browser: how each names what a comment replies to, how X weighs
 * text, Instagram's media ids, the page-typed writers' steps (`compose`) on a stand-in page, and the
 * API writers' requests and refusals on `ScriptedBrowser` pages answering like the platforms.
 */
import { describe, expect, it } from 'vitest';
import { PlatformBlocked } from '../src/collect.ts';
import { AUTO_LINE, AUTO_LINE_ZH, CommentRefused } from '../src/comments.ts';
import { TimeUp, type FetchedText, type PageSession } from '../src/browser.ts';
import { bilibiliReplyTarget, postBilibiliComment, postBilibiliDynamic } from '../src/platforms/bilibili.ts';
import { carries, compose, findKey, jsonOf, labelled, type ComposeSteps } from '../src/platforms/compose.ts';
import { facebookReplyTarget } from '../src/platforms/facebook.ts';
import { ADAPTERS, POST_PLATFORMS, limitOf, markOf } from '../src/platforms/index.ts';
import { instagramReplyTarget, mediaIdOf, postInstagramComment } from '../src/platforms/instagram.ts';
import { AUTO_NOTE, postRedditSubmission, subredditOf } from '../src/platforms/reddit.ts';
import { rednoteReplyTarget } from '../src/platforms/rednote.ts';
import { threadsReplyTarget } from '../src/platforms/threads.ts';
import { xLength, xReplyTarget } from '../src/platforms/x.ts';
import { ScriptedBrowser, json, type PageScript } from './helpers/scripted-browser.ts';

const u = (s: string) => new URL(s);
const LIMITS = { timeLeft: () => 60_000 };

/** Runs `fn` on a scripted page answering from `script`; the browser keeps what was asked. */
async function onPage<T>(script: PageScript, fn: (page: PageSession) => Promise<T>): Promise<{ result: T | unknown; browser: ScriptedBrowser }> {
  const browser = new ScriptedBrowser(script);
  const result = await browser.withPage(fn, LIMITS).catch((e: unknown) => e);
  return { result, browser };
}

describe('what a comment replies to', () => {
  it('X: the post id from any status link', () => {
    expect(xReplyTarget(u('https://x.com/fixture_alice/status/1850000000000000001/photo/1'))).toBe('1850000000000000001');
    expect(xReplyTarget(u('https://twitter.com/i/web/status/1850000000000000001'))).toBe('1850000000000000001');
    expect(xReplyTarget(u('https://x.com/fixture_alice'))).toBeNull();
    expect(xReplyTarget(u('https://fixture.test/fixture_alice/status/1'))).toBeNull();
  });

  it("Threads: the post's page, on threads.com", () => {
    expect(threadsReplyTarget(u('https://www.threads.net/@fixture.alice/post/DAbC_d-1?xmt=1'))).toBe('https://www.threads.com/@fixture.alice/post/DAbC_d-1');
    expect(threadsReplyTarget(u('https://www.threads.com/@fixture.alice'))).toBeNull();
  });

  it("Instagram: the post's shortcode, but no comment's", () => {
    expect(instagramReplyTarget(u('https://www.instagram.com/fixture_alice/p/DAbCdEf1234/'))).toBe('DAbCdEf1234');
    expect(instagramReplyTarget(u('https://www.instagram.com/reel/DAbCdEf1234/'))).toBe('DAbCdEf1234');
    expect(instagramReplyTarget(u('https://www.instagram.com/p/DAbCdEf1234/c/17890000000000001/'))).toBeNull();
    expect(instagramReplyTarget(u('https://www.instagram.com/fixture_alice/'))).toBeNull();
  });

  it('Bilibili: the video, with the comment a #reply link names', () => {
    expect(bilibiliReplyTarget(u('https://www.bilibili.com/video/BV1Fx411c7Ab/?p=2'))).toBe('BV1Fx411c7Ab');
    expect(bilibiliReplyTarget(u('https://www.bilibili.com/video/BV1Fx411c7Ab#reply5005'))).toBe('BV1Fx411c7Ab#5005');
    expect(bilibiliReplyTarget(u('https://space.bilibili.com/2'))).toBeNull();
  });

  it("Facebook: a post's, video's or photo's page, but no comment's", () => {
    expect(facebookReplyTarget(u('https://facebook.com/fixturegroup/posts/123?ref=share'))).toBe('https://www.facebook.com/fixturegroup/posts/123?ref=share');
    expect(facebookReplyTarget(u('https://www.facebook.com/permalink.php?story_fbid=123&id=4'))).toBe('https://www.facebook.com/permalink.php?story_fbid=123&id=4');
    expect(facebookReplyTarget(u('https://www.facebook.com/fixturegroup/posts/123?comment_id=987'))).toBeNull();
    expect(facebookReplyTarget(u('https://www.facebook.com/fixturegroup'))).toBeNull();
  });

  it("Rednote: the note's page with the token its link carries", () => {
    const id = 'a1'.repeat(12);
    expect(rednoteReplyTarget(u(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=F`))).toBe(`https://www.xiaohongshu.com/explore/${id}?xsec_token=F`);
    expect(rednoteReplyTarget(u('https://www.xiaohongshu.com/explore'))).toBeNull();
  });

  it('YouTube and Substack: a video or a post, but no comment under it', () => {
    expect(ADAPTERS.youtube.write.replyTarget(u('https://www.youtube.com/watch?v=aaaaaaaaaaa&t=30'))).toBe('aaaaaaaaaaa');
    expect(ADAPTERS.youtube.write.replyTarget(u('https://www.youtube.com/watch?v=aaaaaaaaaaa&lc=UgxFixture'))).toBeNull();
    expect(ADAPTERS.substack.write.replyTarget(u('https://fixturewriter.substack.com/p/autumn-walks/comments'))).toBe('https://fixturewriter.substack.com/p/autumn-walks/comments');
    expect(ADAPTERS.substack.write.replyTarget(u('https://fixturewriter.substack.com/p/autumn-walks/comment/55'))).toBeNull();
  });

  it('Reddit: the subreddit a new post goes to, however it is written', () => {
    for (const q of ['r/fixture', '/r/fixture/', 'fixture', 'https://www.reddit.com/r/fixture/new/']) expect(subredditOf(q), q).toBe('fixture');
    expect(subredditOf('r/a')).toBeNull();
    expect(subredditOf('two words')).toBeNull();
  });
});

describe('lengths and limits', () => {
  it('weighs text as X does: a link 23, a Latin letter 1, a CJK character or an emoji 2', () => {
    expect(xLength('Hello, world.')).toBe(13);
    expect(xLength('see https://fixture.test/a/very/long/path?with=query')).toBe(4 + 23);
    expect(xLength('你好')).toBe(4);
    expect(xLength('ok 👍')).toBe(5);
  });

  it('marks automatic writing in the language of the Chinese platforms, and in Markdown on Reddit', () => {
    expect([markOf('bilibili', 'comment'), markOf('bilibili', 'post'), markOf('rednote', 'comment')]).toEqual([AUTO_LINE_ZH, AUTO_LINE_ZH, AUTO_LINE_ZH]);
    expect([markOf('reddit', 'post'), markOf('x', 'comment'), markOf('substack', 'note')]).toEqual([AUTO_NOTE, AUTO_LINE, AUTO_LINE]);
  });

  it('leaves room in the bot\'s text for the mark and the blank line before it', () => {
    expect(limitOf('x', 'comment', false)).toBe(280);
    expect(limitOf('x', 'comment', true)).toBe(280 - xLength(AUTO_LINE) - 2);
    expect(limitOf('rednote', 'comment', true)).toBe(280 - AUTO_LINE_ZH.length - 2);
    expect(limitOf('reddit', 'post', false)).toBe(40_000);
    expect(limitOf('substack', 'note', false)).toBe(10_000);
    expect(POST_PLATFORMS).toEqual(['reddit', 'x', 'threads', 'bilibili']);
  });

  it("reads an Instagram post's media id from its shortcode", () => {
    expect(mediaIdOf('B')).toBe('1');
    expect(mediaIdOf('BA')).toBe('64');
    // a private post's longer shortcode carries the id in its first 11 characters
    expect(mediaIdOf('CxyzABCdefgHIJKLmnopqrstuvwxyz')).toBe(mediaIdOf('CxyzABCdefg'));
    expect(mediaIdOf('A')).toBeNull();
    expect(mediaIdOf('no/slashes')).toBeNull();
  });
});

describe('finding the request that carried the text', () => {
  it('matches a body with the first long run of letters as typed, URL-encoded or JSON-escaped, in any case', () => {
    const re = carries('Ok, thoughtfully written — merci');
    expect(re.test('text=thoughtfully+written')).toBe(true);
    expect(re.test('{"text":"THOUGHTFULLY"}')).toBe(true);
    expect(re.test('other=words')).toBe(false);
    // punctuation, which a form escapes where encodeURIComponent does not, is left out
    expect(carries("it's (really) good").test(new URLSearchParams({ text: "it's (really) good" }).toString())).toBe(true);
    expect(carries('café au lait').test(new URLSearchParams({ text: 'café au lait' }).toString())).toBe(true);
    const zh = carries('今天读完了一本好书');
    expect(zh.test(JSON.stringify({ t: '今天读完了一本好书' }))).toBe(true);
    // escaped as ASCII, the hex digits in capitals
    const escaped = Array.from('今天读完了一本好书', (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase()}`).join('');
    expect(zh.test(`{"t":"${escaped}"}`)).toBe(true);
    expect(zh.test(`c=${encodeURIComponent('今天读完了一本好书')}`)).toBe(true);
    expect(carries('a "quoted" text').test('{"t":"a \\"quoted\\" text"}')).toBe(true);
  });

  it('finds a key at any depth, reads JSON behind a prefix, and names buttons by their words', () => {
    expect(findKey({ data: { create: [{ result: { rest_id: '18' } }] } }, 'rest_id')).toBe('18');
    expect(findKey({ a: 1 }, 'rest_id')).toBeNull();
    expect(jsonOf('for (;;);{"ok":1}')).toEqual({ ok: 1 });
    expect(jsonOf('<html>')).toBeNull();
    expect(labelled('div[role="dialog"]', 'button', ['Post', '发布'])).toBe('div[role="dialog"] button:text-is("Post"), div[role="dialog"] button:text-is("发布")');
  });
});

/** A stand-in page for `compose`: the selectors that show, the address it is at, and the answer the send gets. */
function standIn(opts: { shows?: string[]; at?: string; answer?: FetchedText | null }) {
  const did: string[] = [];
  let bodyPattern: RegExp | undefined;
  const page = {
    url: () => opts.at ?? 'https://fixture.test/post',
    click: async (selector: string) => { did.push(`click ${selector}`); return (opts.shows ?? []).includes(selector); },
    type: async (text: string) => { did.push(`type ${text}`); },
    press: async (key: string) => { did.push(`press ${key}`); },
    captureResponse: async (_match: RegExp, action: () => Promise<unknown>, _ms: number, body?: RegExp) => {
      bodyPattern = body;
      await action();
      return opts.answer === undefined ? { status: 200, text: '{}' } : opts.answer;
    },
  } as unknown as PageSession;
  return { page, did, body: () => bodyPattern };
}

const STEPS: ComposeSteps = { open: ['#placeholder', '#other'], box: '#box', send: '#send', request: /\/create/ };

describe('typing into a platform page', () => {
  it('opens the box with the first opener that shows, types, sends, and waits for the request that carries the text', async () => {
    const { page, did, body } = standIn({ shows: ['#other', '#box', '#send'] });
    expect(await compose(page, 'x', STEPS, 'A fine thought')).toEqual({ status: 200, text: '{}' });
    expect(did).toEqual(['click #placeholder', 'click #other', 'click #box', 'type A fine thought', 'click #send']);
    expect(body()?.source).toBe(carries('A fine thought').source);
  });

  it('presses Enter where the platform sends on Enter, and types nothing into a box a share intent filled', async () => {
    const enter = standIn({ shows: ['#box'] });
    await compose(enter.page, 'facebook', { box: '#box', request: /graphql/ }, 'Well said');
    expect(enter.did).toEqual(['click #box', 'type Well said', 'press Enter']);
    const filled = standIn({ shows: ['#box', '#send'] });
    await compose(filled.page, 'threads', { box: '#box', send: '#send', request: /threads/, filled: true }, 'Well said');
    expect(filled.did).toEqual(['click #box', 'click #send']);
  });

  it('asks for a login when the box is missing on a login page, and refuses otherwise', async () => {
    const login = standIn({ at: 'https://fixture.test/i/flow/login' });
    expect(await compose(login.page, 'x', STEPS, 'x').catch((e: unknown) => e)).toMatchObject({ kind: 'login' });
    const changed = standIn({});
    expect(await compose(changed.page, 'x', STEPS, 'x').catch((e: unknown) => e)).toBeInstanceOf(CommentRefused);
  });

  it('refuses when no send button shows, and says the text may be up when the platform does not answer', async () => {
    const noSend = standIn({ shows: ['#box'] });
    expect(await compose(noSend.page, 'x', STEPS, 'x').catch((e: unknown) => e)).toMatchObject({ detail: 'no send button showed on the page' });
    expect(noSend.did).not.toContain('press Enter');
    const silent = standIn({ shows: ['#box', '#send'], answer: null });
    expect(await compose(silent.page, 'x', STEPS, 'x').catch((e: unknown) => e)).toBeInstanceOf(TimeUp);
  });

  it("words the platform's answer: a login for 401 and 403, a block for 429, a refusal for another error", async () => {
    const answered = async (status: number) => compose(standIn({ shows: ['#box', '#send'], answer: { status, text: '' } }).page, 'x', STEPS, 'x').catch((e: unknown) => e);
    expect(await answered(401)).toMatchObject({ kind: 'login' });
    expect(await answered(403)).toMatchObject({ kind: 'login' });
    expect(await answered(429)).toMatchObject({ kind: 'blocked' });
    expect(await answered(500)).toMatchObject({ detail: 'HTTP 500' });
  });
});

describe('writers that call the platform', () => {
  it("Reddit: submits a text post to the subreddit named, with the login's modhash", async () => {
    const sent: Array<{ headers: Record<string, string>; form: Record<string, string> }> = [];
    const script: PageScript = {
      fetch: (url, init) => {
        if (url.endsWith('/api/me.json')) return json({ kind: 't2', data: { name: 'fixture_alice', modhash: 'fixturehash' } });
        if (!url.endsWith('/api/submit')) return undefined;
        sent.push({ headers: init?.headers as Record<string, string>, form: Object.fromEntries(new URLSearchParams(init?.body)) });
        return json({ json: { errors: [], data: { url: 'https://www.reddit.com/r/fixture/comments/n1/late_ramen/' } } });
      },
    };
    const { result } = await onPage(script, (page) => postRedditSubmission(page, { text: 'Where?', title: 'Late ramen', community: 'https://www.reddit.com/r/fixture/' }));
    expect(result).toEqual({ link: 'https://www.reddit.com/r/fixture/comments/n1/late_ramen/' });
    expect(sent).toEqual([{ headers: expect.objectContaining({ 'x-modhash': 'fixturehash' }), form: expect.objectContaining({ sr: 'fixture', kind: 'self', title: 'Late ramen', text: 'Where?' }) }]);
    const nowhere = await onPage(script, (page) => postRedditSubmission(page, { text: 'Where?', title: 'Late ramen', community: 'two words' }));
    expect(nowhere.result).toMatchObject({ detail: 'no subreddit was named' });
  });

  it("Bilibili: asks for a login without the token cookie, and words Bilibili's codes", async () => {
    const noCookie = await onPage({ run: () => '' }, (page) => postBilibiliDynamic(page, { text: '你好' }));
    expect(noCookie.result).toBeInstanceOf(PlatformBlocked);
    expect(noCookie.browser.requests.filter((r) => r.includes('/dyn'))).toEqual([]);
    const answering = (body: unknown, status = 200): PageScript => ({ run: () => 'fixturejct', fetch: () => json(body, status) });
    const dynamic = async (script: PageScript) => (await onPage(script, (page) => postBilibiliDynamic(page, { text: '你好' }))).result;
    expect(await dynamic(answering({ code: -101, message: '账号未登录' }))).toMatchObject({ kind: 'login' });
    expect(await dynamic(answering({ code: -352, message: '风控校验失败' }))).toMatchObject({ kind: 'captcha' });
    expect(await dynamic(answering({}, 412))).toMatchObject({ kind: 'captcha' });
    expect(await dynamic(answering({ code: 4126013, message: '内容含有敏感词' }))).toMatchObject({ detail: '内容含有敏感词' });
    expect(await dynamic(answering({ code: 0, data: { dyn_id_str: '9001' } }))).toEqual({ link: 'https://www.bilibili.com/opus/9001' });
  });

  it('Bilibili: refuses a comment on a video it cannot find', async () => {
    const script: PageScript = { run: () => 'fixturejct', fetch: (url) => (url.includes('/x/web-interface/view') ? json({ code: 0, data: {} }) : undefined) };
    expect((await onPage(script, (page) => postBilibiliComment(page, 'BV1Fx411c7Ab', '好'))).result).toMatchObject({ detail: 'the video was not found' });
  });

  it("Instagram: comments by the media id, with the login's CSRF token, and words Instagram's refusals", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; form: Record<string, string> }> = [];
    const answer = { current: json({ id: '17890000000000001', text: 'Lovely light.', status: 'ok' }) as FetchedText };
    const script: PageScript = {
      run: () => 'fixturecsrf',
      fetch: (url, init) => {
        sent.push({ url, headers: init?.headers as Record<string, string>, form: Object.fromEntries(new URLSearchParams(init?.body)) });
        return answer.current;
      },
    };
    const { result } = await onPage(script, (page) => postInstagramComment(page, 'BA', 'Lovely light.'));
    expect(result).toEqual({ link: 'https://www.instagram.com/p/BA/c/17890000000000001/' });
    expect(sent).toEqual([{
      url: 'https://www.instagram.com/api/v1/web/comments/64/add/',
      headers: expect.objectContaining({ 'x-csrftoken': 'fixturecsrf', 'x-ig-app-id': expect.any(String) }),
      form: { comment_text: 'Lovely light.' },
    }]);
    answer.current = json({ message: 'login_required', status: 'fail' }, 401);
    expect((await onPage(script, (page) => postInstagramComment(page, 'BA', 'x'))).result).toMatchObject({ kind: 'login' });
    answer.current = json({ message: 'Comments on this post have been limited.', status: 'fail' }, 400);
    expect((await onPage(script, (page) => postInstagramComment(page, 'BA', 'x'))).result).toMatchObject({ detail: 'Comments on this post have been limited.' });
    expect((await onPage({ run: () => '' }, (page) => postInstagramComment(page, 'BA', 'x'))).result).toMatchObject({ kind: 'login' });
  });
});
