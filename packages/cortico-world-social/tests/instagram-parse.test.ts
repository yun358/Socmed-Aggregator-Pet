/** instagram-parse.ts: Instagram's web JSON (profile nodes and media objects) read into posts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInstagramPosts } from '../src/platforms/instagram-parse.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('a profile payload', () => {
  const posts = parseInstagramPosts(fixture('instagram-profile.json'));
  const byId = (id: string) => posts.find((p) => p.id === id)!;

  it("lists the profile's posts in order, each by the profile's owner", () => {
    expect(posts.map((p) => p.id)).toEqual(['FXimg001', 'FXvid002', 'FXcar003', 'FXcar004']);
    expect(new Set(posts.map((p) => p.author))).toEqual(new Set(['fixture.cafe']));
  });

  it('reads an image post: caption, image with its description, time and counts', () => {
    expect(byId('FXimg001')).toMatchObject({
      platform: 'instagram',
      url: 'https://www.instagram.com/p/FXimg001/',
      text: 'New menu\nfrom Monday',
      images: [{ url: 'https://scontent.cdninstagram.com/v/fixture001.jpg?stp=dst-jpg', alt: 'Photo of a menu board with prices.' }],
      publishedAt: new Date(1792634400 * 1000).toISOString(),
      video: false,
      extraction: 'adapter',
    });
    expect(byId('FXimg001').stats).toEqual([['likes', '210'], ['comments', '4']]);
  });

  it('reads a video post as a video without images, its likes from the preview count', () => {
    expect(byId('FXvid002')).toMatchObject({ video: true, images: [], text: '' });
    expect(byId('FXvid002').stats).toEqual([['likes', '33'], ['comments', '1']]);
  });

  it("reads a carousel's images in order, its videos left out", () => {
    expect(byId('FXcar003').images).toEqual([
      { url: 'https://scontent.cdninstagram.com/v/fixture031.jpg', alt: 'Photo of noodles.' },
      { url: 'https://scontent.cdninstagram.com/v/fixture033.jpg' },
    ]);
    expect(byId('FXcar003').video).toBe(false);
  });

  it('reads a carousel of videos only as a video post', () => {
    expect(byId('FXcar004')).toMatchObject({ video: true, images: [] });
  });
});

describe('a tag payload', () => {
  const posts = parseInstagramPosts(fixture('instagram-tag.json'));
  const byId = (id: string) => posts.find((p) => p.id === id)!;

  it('lists each post once across the top and recent sections', () => {
    expect(posts.map((p) => p.id)).toEqual(['FXtag001', 'FXtag002', 'FXtag003', 'FXtag004']);
  });

  it('reads a media object: author, caption, the largest image rendition with its description, time and counts', () => {
    expect(byId('FXtag001')).toMatchObject({
      url: 'https://www.instagram.com/p/FXtag001/',
      author: 'fixture.eater',
      text: 'Best dumplings\non the street',
      images: [{ url: 'https://scontent.cdninstagram.com/v/fixturetag001-1080.jpg', alt: 'Photo of a plate of dumplings.' }],
      publishedAt: new Date(1792634400 * 1000).toISOString(),
      video: false,
    });
    expect(byId('FXtag001').stats).toEqual([['likes', '57'], ['comments', '6']]);
  });

  it('reads a video without images or caption', () => {
    expect(byId('FXtag002')).toMatchObject({ video: true, images: [], text: '' });
  });

  it("reads a carousel's images in order, its videos left out; a carousel of videos only is a video post", () => {
    expect(byId('FXtag003').images).toEqual([
      { url: 'https://scontent.cdninstagram.com/v/fixturetag031.jpg', alt: 'Photo of bread.' },
      { url: 'https://scontent.cdninstagram.com/v/fixturetag033.jpg' },
    ]);
    expect(byId('FXtag003').video).toBe(false);
    expect(byId('FXtag004')).toMatchObject({ video: true, images: [] });
  });
});

describe('payloads without posts', () => {
  it('finds nothing in an error, a login demand or an empty result', () => {
    for (const raw of [null, { status: 'fail', message: 'checkpoint_required' }, { require_login: true }, { data: { user: null } }, []]) {
      expect(parseInstagramPosts(raw)).toEqual([]);
    }
  });
});
