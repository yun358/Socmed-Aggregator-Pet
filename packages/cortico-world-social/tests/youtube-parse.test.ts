/** youtube-parse.ts: YouTube's page data, channel feed and caption payloads read into videos and transcripts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatDuration, parseCaptionTracks, parseCaptionXml, parseJson3, parseTranscriptPanel, parseVideoDetails, parseYoutubeChannel,
  parseYoutubeFeed, parseYoutubeVideos, pickCaptionTrack, youtubeVideoId, ytText, type CaptionTrack,
} from '../src/platforms/youtube-parse.ts';

const text = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));

describe('ytText', () => {
  it('reads the three text shapes and gives empty text for anything else', () => {
    expect(ytText({ simpleText: 'a' })).toBe('a');
    expect(ytText({ runs: [{ text: 'a' }, { text: 'b' }, { bold: true }] })).toBe('ab');
    expect(ytText({ content: 'c' })).toBe('c');
    expect(ytText('plain')).toBe('plain');
    for (const v of [null, undefined, 3, [], { other: 'x' }]) expect(ytText(v)).toBe('');
  });
});

describe('parseYoutubeVideos', () => {
  const videos = parseYoutubeVideos(fixture('youtube-search.json'));

  it('lists every video once in page order: classic renderers, lockups and Shorts; ads, playlists, channels and untitled entries left out', () => {
    expect(videos.map((v) => v.id)).toEqual(['fixtureVid1', 'fixtureVid2', 'fixtureSht1', 'fixtureSht2']);
  });

  it('reads a classic video renderer with its snippet', () => {
    expect(videos[0]).toMatchObject({
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=fixtureVid1',
      title: 'Harbour festival recap',
      author: 'Fixture Channel',
      text: 'Highlights from the harbour festival.',
      publishedText: '2 days ago',
      duration: '12:34',
      video: true,
      images: [],
    });
    expect(videos[0].stats).toEqual([['', '1,234 views']]);
  });

  it('reads a lockup: channel row, views, age and the length badge', () => {
    expect(videos[1]).toMatchObject({
      title: 'Night market walk',
      author: 'Second Fixture Channel',
      publishedText: '3 weeks ago',
      duration: '1:02:03',
    });
    expect(videos[1].stats).toEqual([['', '5.1K views']]);
  });

  it('marks Shorts in the title and links them as Shorts', () => {
    expect(videos[2]).toMatchObject({ title: 'Festival in 30 seconds (Short)', url: 'https://www.youtube.com/shorts/fixtureSht1' });
    expect(videos[3]).toMatchObject({ title: 'Lantern parade (Short)', url: 'https://www.youtube.com/shorts/fixtureSht2' });
    expect(videos[3].stats).toEqual([['', '12K views']]);
  });

  it('reads the videos tab of a channel page, and finds nothing in a payload without videos', () => {
    expect(parseYoutubeVideos(fixture('youtube-channel.json')).map((v) => [v.id, v.title, v.text])).toEqual([
      ['fixtureCh01', 'Newest upload', 'What changed this week.'],
      ['fixtureCh02', 'Older upload', ''],
    ]);
    expect(parseYoutubeVideos(null)).toEqual([]);
    expect(parseYoutubeVideos({ contents: {} })).toEqual([]);
  });
});

describe('parseYoutubeChannel', () => {
  it('reads the channel id and name of a channel page, null elsewhere', () => {
    expect(parseYoutubeChannel(fixture('youtube-channel.json'))).toEqual({ id: 'UCfixture0000000000000001', name: 'Fixture Channel' });
    expect(parseYoutubeChannel(fixture('youtube-search.json'))).toBeNull();
  });
});

describe('parseYoutubeFeed', () => {
  const feed = parseYoutubeFeed(text('youtube-feed.xml'));

  it('reads the entries newest first with entities decoded, exact times and view counts', () => {
    expect(feed.map((v) => v.id)).toEqual(['fixtureCh01', 'fixtureSh01']);
    expect(feed[0]).toMatchObject({
      url: 'https://www.youtube.com/watch?v=fixtureCh01',
      title: 'Q&A: what "changed" this week',
      author: 'Fixture Channel',
      text: 'Questions from viewers — answered.',
      publishedAt: '2026-10-21T08:00:00+00:00',
    });
    expect(feed[0].stats).toEqual([['', '900 views']]);
  });

  it('recognises a Short by its link', () => {
    expect(feed[1]).toMatchObject({ title: 'Quick tip (Short)', url: 'https://www.youtube.com/shorts/fixtureSh01' });
  });

  it('reads a feed without entries as empty', () => {
    expect(parseYoutubeFeed('<feed><title>Empty</title></feed>')).toEqual([]);
  });
});

describe('caption payloads', () => {
  it('json3: one line per caption event, newlines joined, events without text left out, start in whole seconds', () => {
    expect(parseJson3(fixture('youtube-json3.json'))).toEqual([
      { startSec: 1, text: 'welcome to the harbour' },
      { startSec: 5, text: 'the boats leave at noon' },
      { startSec: 65, text: '[Music]' },
    ]);
    expect(parseJson3({})).toEqual([]);
  });

  it('srv3 XML: paragraphs with their inner tags removed and entities decoded', () => {
    const xml = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>'
      + '<p t="1500" d="2000"><s>it&#39;s</s><s t="400"> a</s><s t="800"> test</s></p>'
      + '<p t="4000" d="10" a="1">\n</p>'
      + '<p t="61000" d="2000">fish &amp; chips</p></body></timedtext>';
    expect(parseCaptionXml(xml)).toEqual([{ startSec: 2, text: "it's a test" }, { startSec: 61, text: 'fish & chips' }]);
  });

  it('the older XML: text elements, whose content is escaped twice', () => {
    const xml = '<?xml version="1.0" encoding="utf-8" ?><transcript>'
      + '<text start="0.5" dur="2">it&amp;#39;s &amp;lt;i&amp;gt;fine&amp;lt;/i&amp;gt;</text>'
      + '<text start="12.4" dur="2">second\nline</text></transcript>';
    expect(parseCaptionXml(xml)).toEqual([{ startSec: 1, text: "it's fine" }, { startSec: 12, text: 'second line' }]);
  });

  it('the transcript panel: segments in order, section headers and empty segments left out', () => {
    expect(parseTranscriptPanel(fixture('youtube-transcript-panel.json'))).toEqual([
      { startSec: 0, text: 'first line' },
      { startSec: 3, text: 'second line' },
      { startSec: 126, text: 'last line' },
    ]);
  });
});

describe('caption tracks', () => {
  const tracks = parseCaptionTracks(fixture('youtube-player.json'));

  it('lists the tracks with a URL, generated ones marked', () => {
    expect(tracks.map((t) => [t.languageCode, t.name, t.kind])).toEqual([
      ['fr', 'French', undefined],
      ['en', 'English (auto-generated)', 'asr'],
      ['en-GB', 'English (United Kingdom)', undefined],
    ]);
    expect(parseCaptionTracks({ playabilityStatus: { status: 'OK' } })).toEqual([]);
  });

  it("picks a person-made track in the video's own language, the generated track's", () => {
    expect(pickCaptionTrack(tracks)?.languageCode).toBe('en-GB');
  });

  it('picks the first person-made track when none is in the own language, and the generated one when it is alone', () => {
    const track = (languageCode: string, kind?: string): CaptionTrack => ({ baseUrl: `https://example.test/${languageCode}`, languageCode, name: languageCode, ...(kind ? { kind } : {}) });
    expect(pickCaptionTrack([track('ja', 'asr'), track('fr'), track('de')])?.languageCode).toBe('fr');
    expect(pickCaptionTrack([track('fr'), track('de')])?.languageCode).toBe('fr');
    expect(pickCaptionTrack([track('ja', 'asr')])?.kind).toBe('asr');
    expect(pickCaptionTrack([])).toBeNull();
  });
});

describe('parseVideoDetails and formatDuration', () => {
  it('reads title, channel and length', () => {
    expect(parseVideoDetails(fixture('youtube-player.json'))).toEqual({ title: 'Harbour festival recap', author: 'Fixture Channel', duration: '1:02:05' });
    expect(parseVideoDetails(null)).toEqual({ title: undefined, author: undefined, duration: undefined });
  });

  it('writes m:ss under an hour and h:mm:ss from an hour on', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(754)).toBe('12:34');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(36125)).toBe('10:02:05');
  });
});

describe('youtubeVideoId', () => {
  it('finds the id in every URL shape and takes a bare id', () => {
    for (const ref of [
      'fixtureVid1',
      ' fixtureVid1 ',
      'https://www.youtube.com/watch?v=fixtureVid1&t=30s',
      'https://m.youtube.com/watch?v=fixtureVid1',
      'https://youtu.be/fixtureVid1?si=abc',
      'https://www.youtube.com/shorts/fixtureVid1',
      'https://www.youtube.com/embed/fixtureVid1',
      'https://www.youtube.com/live/fixtureVid1?feature=share',
    ]) expect(youtubeVideoId(ref), ref).toBe('fixtureVid1');
  });

  it('gives null for other sites, channel pages and text', () => {
    for (const ref of ['https://example.org/watch?v=fixtureVid1', 'https://www.youtube.com/@fixturechannel', 'riots in France', '']) {
      expect(youtubeVideoId(ref), ref).toBeNull();
    }
  });
});
