/** bilibili-parse.ts: Bilibili's web API payloads read into videos and subtitles, and the WBI signature. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bilibiliVideoId, parseBilibiliSubtitleBody, parseBilibiliSubtitles, parseBilibiliUser, parseBilibiliVideos, parseBilibiliView,
  wbiKeys, wbiMixinKey, wbiSign,
} from '../src/platforms/bilibili-parse.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('parseBilibiliVideos', () => {
  it('reads search results: keyword marks and entities removed, string lengths kept, other result types left out', () => {
    const videos = parseBilibiliVideos(fixture('bilibili-search.json'));
    expect(videos.map((v) => v.id)).toEqual(['BV1TEST00001', 'BV1TEST00002']);
    expect(videos[0]).toMatchObject({
      platform: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1TEST00001',
      title: '夜市探店 & 小吃',
      author: '测试UP主',
      text: '一条 合成的\n简介',
      duration: '12:34',
      publishedAt: new Date(1792634400 * 1000).toISOString(),
      video: true,
      images: [],
      extraction: 'adapter',
    });
    expect(videos[0].stats).toEqual([['views', '12345']]);
    expect(videos[1].title).toBe('第二个夜市视频');
  });

  it('reads the home recommendations: only video entries, lengths in seconds formatted', () => {
    const videos = parseBilibiliVideos(fixture('bilibili-rcmd.json'));
    expect(videos.map((v) => [v.id, v.author, v.duration])).toEqual([
      ['BV1TEST00003', '推荐UP主', '12:34'],
      ['BV1TEST00004', '推荐UP主二', '1:02:05'],
    ]);
    expect(videos[0].stats).toEqual([['views', '98765']]);
  });

  it("reads an uploader's video list", () => {
    const videos = parseBilibiliVideos(fixture('bilibili-space.json'));
    expect(videos.map((v) => [v.id, v.title, v.author, v.duration, v.text])).toEqual([
      ['BV1TEST00005', '最新投稿', '测试UP主', '05:07', '空间里的最新视频'],
      ['BV1TEST00006', '旧投稿', '测试UP主', '1:00:00', ''],
    ]);
    expect(videos[0].publishedAt).toBe(new Date(1792634400 * 1000).toISOString());
  });

  it('reads the popular list and finds nothing in an error payload', () => {
    const popular = { code: 0, data: { list: [{ bvid: 'BV1TEST00007', title: '热门', owner: { name: '热门UP主' }, stat: { view: 5 }, duration: 61, pubdate: 1792634400, desc: '-' }] } };
    expect(parseBilibiliVideos(popular).map((v) => [v.id, v.duration, v.text])).toEqual([['BV1TEST00007', '1:01', '-']]);
    expect(parseBilibiliVideos({ code: -412, message: '请求被拦截' })).toEqual([]);
    expect(parseBilibiliVideos(null)).toEqual([]);
  });
});

describe('video details and subtitles', () => {
  it("reads the view payload's first part", () => {
    expect(parseBilibiliView(fixture('bilibili-view.json'))).toEqual({ bvid: 'BV1TEST00001', cid: 700000001, title: '夜市探店 & 小吃', author: '测试UP主', duration: '1:02:05' });
    expect(parseBilibiliView({ code: -404, data: null })).toBeNull();
  });

  it('lists subtitle tracks with absolute URLs, AI ones marked, tracks without a file left out', () => {
    expect(parseBilibiliSubtitles(fixture('bilibili-player.json'))).toEqual({
      tracks: [
        { url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture-ai.json', language: '中文(自动生成)', generated: true },
        { url: 'https://i0.hdslb.com/bfs/subtitle/fixture-zh.json', language: '中文(中国)', generated: false },
      ],
      needLogin: false,
    });
  });

  it('reports that subtitles need a login', () => {
    expect(parseBilibiliSubtitles({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } })).toEqual({ tracks: [], needLogin: true });
  });

  it('reads a subtitle file: whole-second starts, whitespace joined, empty lines left out', () => {
    expect(parseBilibiliSubtitleBody(fixture('bilibili-subtitle.json'))).toEqual([
      { startSec: 0, text: '大家好 欢迎来到夜市' },
      { startSec: 31, text: '这家店开了二十年' },
    ]);
    expect(parseBilibiliSubtitleBody({})).toEqual([]);
  });

  it('reads the best-matching uploader of a user search', () => {
    expect(parseBilibiliUser(fixture('bilibili-user.json'))).toEqual({ mid: 20000001, name: '测试UP主' });
    expect(parseBilibiliUser({ code: 0, data: { result: [] } })).toBeNull();
  });
});

describe('bilibiliVideoId', () => {
  it('finds the BV id in a video URL and takes a bare one', () => {
    expect(bilibiliVideoId('https://www.bilibili.com/video/BV1TEST00001/?spm_id_from=333.1007')).toBe('BV1TEST00001');
    expect(bilibiliVideoId(' BV1TEST00001 ')).toBe('BV1TEST00001');
    expect(bilibiliVideoId('https://m.bilibili.com/video/BV1TEST00001')).toBe('BV1TEST00001');
  });

  it('gives null without a BV id', () => {
    for (const ref of ['https://www.bilibili.com/video/av100000001', 'https://space.bilibili.com/20000001', '夜市', 'BV1SHORT']) expect(bilibiliVideoId(ref), ref).toBeNull();
  });
});

describe('WBI signing', () => {
  // the test vector published with the WBI signing documentation
  const keys = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };

  it('derives the published mixin key', () => {
    expect(wbiMixinKey(keys.imgKey, keys.subKey)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('signs the published parameters: keys sorted, wts added, w_rid last', () => {
    expect(wbiSign({ foo: '114', bar: '514', zab: 1919810 }, keys, 1702204169))
      .toBe('bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  });

  it('takes the keys from the file names of nav, which names them logged out too', () => {
    expect(wbiKeys(fixture('bilibili-nav.json'))).toEqual(keys);
    expect(wbiKeys({ code: 0, data: { wbi_img: { img_url: '', sub_url: '' } } })).toBeNull();
    expect(wbiKeys(null)).toBeNull();
  });

  it("encodes values and drops the characters Bilibili's own signer drops", () => {
    const query = wbiSign({ keyword: "夜市 (it's)*!" }, keys, 1702204169);
    expect(query.startsWith(`keyword=${encodeURIComponent('夜市 its')}&wts=1702204169&w_rid=`)).toBe(true);
    expect(query).toMatch(/&w_rid=[0-9a-f]{32}$/);
  });
});
