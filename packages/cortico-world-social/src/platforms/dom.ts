/// <reference lib="dom" />
// The readers here and the in-page functions of the adapters are typed against the page's DOM. The
// reference brings the DOM types into every program that reaches this package, the Node-only root
// typecheck included (through core/companion.ts).
/**
 * Readers that run inside the platform's page (`PageSession.run`), one per page layout, each
 * self-contained: the session serializes the function into the page, so nothing outside it is in
 * scope. They return what the page shows; `toPost` in `collect.ts` turns that into a `Post`.
 *
 * The platform readers rely on the markup each platform uses today. When one finds nothing, the
 * adapter falls back to `readGenericPosts`, which finds posts by page semantics (`article`,
 * `role="article"`, feed children, `time[datetime]`) and so keeps working, more roughly, after a
 * platform changes its markup.
 *
 * A post's text is the `innerText` of its element with the author, time and controls hidden for
 * the read (`textWithout`, repeated in each reader that needs it): `innerText` breaks lines only
 * where the page lays them out, and a detached copy is not laid out.
 */

/** A post as the page shows it. */
export interface DomPost {
  /** Identifies the post across scrolls: its link, else its author and text. */
  key: string;
  url: string;
  author: string;
  text: string;
  /** `datetime` of the post's `time` element. */
  time: string;
  /** The visible relative time, when there is no `datetime`. */
  timeText: string;
  images: Array<{ url: string; alt: string }>;
  video: boolean;
  stats: Array<[string, string]>;
  /** Marked as an ad or sponsored. */
  ad: boolean;
  /** The page cut the text short behind a "show more" control it did not expand. */
  truncated: boolean;
}

export interface DomReadOptions {
  /** Images narrower than this (CSS pixels) are avatars, icons or emoji. */
  minImagePx: number;
}

export const DOM_READ_DEFAULTS: DomReadOptions = { minImagePx: 120 };

/** X (Twitter): `article[data-testid="tweet"]` on the timeline, search and profile pages. */
export function readXPosts(opts: DomReadOptions): DomPost[] {
  const out: DomPost[] = [];
  for (const a of Array.from(document.querySelectorAll('article[data-testid="tweet"]'))) {
    const texts = Array.from(a.querySelectorAll('[data-testid="tweetText"]')).map((e) => (e as HTMLElement).innerText.trim());
    const nameParts = ((a.querySelector('[data-testid="User-Name"]') as HTMLElement | null)?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const handle = nameParts.find((s) => s.startsWith('@')) ?? '';
    const display = nameParts[0] && !nameParts[0].startsWith('@') ? nameParts[0] : '';
    const timeEl = a.querySelector('time');
    const link = (timeEl?.closest('a') as HTMLAnchorElement | null)?.href ?? '';
    const images = Array.from(a.querySelectorAll('[data-testid="tweetPhoto"] img'))
      .map((img) => img as HTMLImageElement)
      .filter((img) => img.src && !img.src.startsWith('data:'))
      .map((img) => ({ url: img.src, alt: img.alt && img.alt !== 'Image' && img.alt !== '图像' ? img.alt : '' }));
    const video = !!a.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video');
    const group = a.querySelector('[role="group"][aria-label]');
    const stats: Array<[string, string]> = group ? [['', group.getAttribute('aria-label') ?? '']] : [];
    const ad = !!a.querySelector('[data-testid="placementTracking"]')
      || Array.from(a.querySelectorAll('span')).some((s) => /^(Ad|Promoted|广告|推广)$/.test((s.textContent ?? '').trim()));
    const text = texts[0] ?? '';
    const quoted = texts.slice(1).filter(Boolean);
    void opts;
    out.push({
      key: link || `${handle}:${text.slice(0, 80)}`,
      url: link,
      author: display && handle ? `${display} (${handle})` : handle || display,
      text: quoted.length ? `${text}\n[quoted] ${quoted.join('\n[quoted] ')}` : text,
      time: timeEl?.getAttribute('datetime') ?? '',
      timeText: '',
      images,
      video,
      stats,
      ad,
      truncated: !!a.querySelector('[data-testid="tweet-text-show-more-link"]'),
    });
  }
  return out;
}

/** Threads: each post is a `div[data-pressable-container="true"]`; a quoted post nests inside one. */
export function readThreadsPosts(opts: DomReadOptions): DomPost[] {
  const textWithout = (el: HTMLElement, junk: string): string => {
    const hidden = Array.from(el.querySelectorAll(junk)).map((e) => [e as HTMLElement, e.getAttribute('style')] as const);
    for (const [e] of hidden) e.style.setProperty('display', 'none', 'important');
    const text = el.innerText;
    for (const [e, style] of hidden) if (style === null) e.removeAttribute('style'); else e.setAttribute('style', style);
    return text;
  };
  const out: DomPost[] = [];
  const all = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
  for (const c of all) {
    if (c.parentElement?.closest('div[data-pressable-container="true"]')) continue;
    const postLink = c.querySelector('a[href*="/post/"]') as HTMLAnchorElement | null;
    const authorLink = Array.from(c.querySelectorAll('a[href^="/@"]')).find((l) => (l.textContent ?? '').trim()) as HTMLAnchorElement | undefined;
    const author = authorLink ? (authorLink.textContent ?? '').trim() : '';
    const timeEl = c.querySelector('time');
    const images = Array.from(c.querySelectorAll('img'))
      .map((img) => img as HTMLImageElement)
      .filter((img) => (img.width || img.naturalWidth || Number(img.getAttribute('width')) || 0) >= opts.minImagePx && !/profile picture|头像/i.test(img.alt))
      .map((img) => ({ url: img.currentSrc || img.src, alt: img.alt }));
    const text = textWithout(c as HTMLElement, 'a[href^="/@"], time, [role="button"], svg, img, video, picture')
      .split('\n').map((s) => s.trim()).filter((s) => s && !/^(\d[\d.,KkMm万]*|Translate|翻译|Author|作者)$/.test(s)).join('\n');
    const url = postLink?.href ?? '';
    out.push({
      key: url || `${author}:${text.slice(0, 80)}`,
      url,
      author,
      text,
      time: timeEl?.getAttribute('datetime') ?? '',
      timeText: '',
      images,
      video: !!c.querySelector('video'),
      stats: [],
      ad: Array.from(c.querySelectorAll('span, div')).some((e) => /^(Sponsored|赞助内容)$/.test((e.textContent ?? '').trim())),
      truncated: false,
    });
  }
  return out;
}

/** Instagram's home feed: one `article` per post. */
export function readInstagramPosts(opts: DomReadOptions): DomPost[] {
  const textWithout = (el: HTMLElement, junk: string): string => {
    const hidden = Array.from(el.querySelectorAll(junk)).map((e) => [e as HTMLElement, e.getAttribute('style')] as const);
    for (const [e] of hidden) e.style.setProperty('display', 'none', 'important');
    const text = el.innerText;
    for (const [e, style] of hidden) if (style === null) e.removeAttribute('style'); else e.setAttribute('style', style);
    return text;
  };
  const out: DomPost[] = [];
  for (const a of Array.from(document.querySelectorAll('article'))) {
    const link = a.querySelector('a[href*="/p/"], a[href*="/reel/"]') as HTMLAnchorElement | null;
    const headerLink = Array.from(a.querySelectorAll('header a[href^="/"]')).find((l) => (l.textContent ?? '').trim()) as HTMLAnchorElement | undefined;
    const author = headerLink ? (headerLink.textContent ?? '').trim() : '';
    const timeEl = a.querySelector('time');
    const images = Array.from(a.querySelectorAll('img'))
      .map((img) => img as HTMLImageElement)
      .filter((img) => (img.width || img.naturalWidth || 0) >= opts.minImagePx && !/profile picture|头像/i.test(img.alt))
      .map((img) => ({ url: img.currentSrc || img.src, alt: img.alt }));
    const text = textWithout(a as HTMLElement, 'header, [role="button"], button, svg, img, video, time, form, textarea')
      .split('\n').map((s) => s.trim())
      .filter((s) => s && !/^(Liked by|View all|Add a comment|See translation|查看全部|添加评论)|^(more|… more|Follow|•|赞|更多)$/i.test(s) && s !== author)
      .join('\n');
    const url = link?.href ?? '';
    out.push({
      key: url || `${author}:${text.slice(0, 80)}`,
      url,
      author,
      text,
      time: timeEl?.getAttribute('datetime') ?? '',
      timeText: '',
      images,
      video: !!a.querySelector('video') || url.includes('/reel/'),
      stats: [],
      ad: Array.from(a.querySelectorAll('header span, header div')).some((e) => /^(Sponsored|赞助内容)$/.test((e.textContent ?? '').trim())),
      truncated: false,
    });
  }
  return out;
}

/**
 * Facebook: feed posts are `[aria-posinset]` or the children of `[role="feed"]`; search results are
 * `[role="article"]` not inside another one (those inside are comments).
 */
export function readFacebookPosts(opts: DomReadOptions): DomPost[] {
  // Facebook pads its "Sponsored" label with hidden characters and may keep it behind aria-labelledby:
  // the rendered text (innerText) of the post's header and of those labels shows it whole
  const facebookAd = (p: Element): boolean => {
    const head = (p.querySelector('[data-ad-rendering-role="meta"]') ?? p.querySelector('h2, h3, h4')?.parentElement ?? null) as HTMLElement | null;
    const labels = Array.from(p.querySelectorAll('[aria-labelledby]')).slice(0, 8)
      .flatMap((e) => (e.getAttribute('aria-labelledby') ?? '').split(/\s+/))
      .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText ?? '');
    return [head?.innerText ?? (p as HTMLElement).innerText.slice(0, 300), ...labels].some((t) => /(^|\s)(Sponsored|赞助内容|贊助)(\s|$|·)/.test(t));
  };
  const out: DomPost[] = [];
  let posts = Array.from(document.querySelectorAll('[aria-posinset]'));
  if (!posts.length) posts = Array.from(document.querySelectorAll('[role="feed"] > div'));
  if (!posts.length) posts = Array.from(document.querySelectorAll('[role="article"]')).filter((a) => !a.parentElement?.closest('[role="article"]'));
  for (const p of posts) {
    const messageEl = p.querySelector('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]') as HTMLElement | null;
    let text = messageEl?.innerText.trim() ?? '';
    if (!text) {
      const blocks = Array.from(p.querySelectorAll('div[dir="auto"]')).filter((d) => !d.closest('[role="article"] [role="article"]') && !d.closest('ul'));
      text = blocks.map((d) => (d as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 6).join('\n');
    }
    const authorEl = p.querySelector('[data-ad-rendering-role="profile_name"] a, h2 a, h3 a, h4 a, strong a') as HTMLAnchorElement | null;
    const link = Array.from(p.querySelectorAll('a[href]')).map((l) => (l as HTMLAnchorElement).href)
      .find((h) => /\/posts\/|story_fbid=|\/permalink\/|\/photo|\/videos\/|\/reel\/|\/groups\/[^/]+\/posts\//.test(h)) ?? '';
    const images = Array.from(p.querySelectorAll('img'))
      .map((img) => img as HTMLImageElement)
      .filter((img) => /scontent|fbcdn/.test(img.src) && (img.width || img.naturalWidth || 0) >= opts.minImagePx)
      .map((img) => ({ url: img.currentSrc || img.src, alt: img.alt }));
    const author = authorEl ? (authorEl.textContent ?? '').trim() : '';
    if (!text && !images.length) continue;
    // Facebook's tracking parameters start with `__`; the others (fbid, story_fbid, id, set) name the post
    let url = '';
    if (link) {
      const u = new URL(link);
      for (const k of Array.from(u.searchParams.keys())) if (k.startsWith('__')) u.searchParams.delete(k);
      url = u.href;
    }
    out.push({
      key: url || `${author}:${text.slice(0, 80)}`,
      url,
      author,
      text,
      time: '',
      timeText: '',
      images,
      video: !!p.querySelector('video') || /\/videos\/|\/reel\/|\/watch/.test(link),
      stats: [],
      ad: facebookAd(p),
      truncated: !!messageEl && /See more|展开/.test(messageEl.innerText.slice(-20)),
    });
  }
  return out;
}

/** Clicks the "See more" controls inside Facebook post messages; returns how many it clicked. */
export function expandFacebookPosts(): number {
  let n = 0;
  for (const b of Array.from(document.querySelectorAll('[role="button"]'))) {
    const t = (b.textContent ?? '').trim();
    if ((t === 'See more' || t === '展开') && b.closest('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"], [dir="auto"]')) {
      (b as HTMLElement).click();
      n++;
    }
  }
  return n;
}

/** A Rednote note card in a listing; the full text is on the note's own page. */
export interface RednoteCard {
  id: string;
  xsecToken: string;
  title: string;
  author: string;
  likes: string;
  cover: string;
  video: boolean;
}

/**
 * Rednote listing pages (explore, search, profile) keep their cards in `window.__INITIAL_STATE__`,
 * whose values are Vue refs (`_rawValue`/`_value`/`value`); the DOM cards are the fallback.
 */
export function readRednoteCards(): RednoteCard[] {
  const unwrap = (v: unknown): unknown => {
    let x = v as Record<string, unknown> | null;
    for (let i = 0; i < 4 && x && typeof x === 'object'; i++) {
      if ('_rawValue' in x) x = x._rawValue as Record<string, unknown>;
      else if ('_value' in x) x = x._value as Record<string, unknown>;
      else if ('value' in x && Object.keys(x).length <= 3) x = x.value as Record<string, unknown>;
      else break;
    }
    return x;
  };
  const state = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
  const lists: unknown[] = [];
  if (state) {
    const feed = unwrap(state.feed) as Record<string, unknown> | null;
    const search = unwrap(state.search) as Record<string, unknown> | null;
    const user = unwrap(state.user) as Record<string, unknown> | null;
    lists.push(unwrap(feed?.feeds), unwrap(search?.feeds));
    const notes = unwrap(user?.notes);
    if (Array.isArray(notes)) lists.push(...notes.map(unwrap));
  }
  const cards: RednoteCard[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const item = unwrap(raw) as Record<string, unknown> | null;
      if (!item) continue;
      const card = (unwrap(item.noteCard) ?? unwrap(item.note_card) ?? item) as Record<string, unknown>;
      const id = String(item.id ?? card.noteId ?? card.note_id ?? '');
      if (!id || (item.modelType && item.modelType !== 'note')) continue;
      const user = (unwrap(card.user) ?? {}) as Record<string, unknown>;
      const interact = (unwrap(card.interactInfo) ?? unwrap(card.interact_info) ?? {}) as Record<string, unknown>;
      const cover = (unwrap(card.cover) ?? {}) as Record<string, unknown>;
      cards.push({
        id,
        xsecToken: String(item.xsecToken ?? item.xsec_token ?? card.xsecToken ?? ''),
        title: String(card.displayTitle ?? card.display_title ?? card.title ?? ''),
        author: String(user.nickname ?? user.nickName ?? user.nick_name ?? ''),
        likes: String(interact.likedCount ?? interact.liked_count ?? ''),
        cover: String(cover.urlDefault ?? cover.url_default ?? cover.url ?? ''),
        video: card.type === 'video',
      });
    }
  }
  if (cards.length) return cards;
  for (const s of Array.from(document.querySelectorAll('section.note-item'))) {
    const a = s.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a.cover') as HTMLAnchorElement | null;
    const href = a?.href ?? '';
    const id = (href.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/) ?? [])[1] ?? '';
    if (!id) continue;
    cards.push({
      id,
      xsecToken: (href.match(/xsec_token=([^&]+)/) ?? [])[1] ?? '',
      title: (s.querySelector('.title, .footer .title span') as HTMLElement | null)?.innerText.trim() ?? '',
      author: (s.querySelector('.author .name, .name') as HTMLElement | null)?.innerText.trim() ?? '',
      likes: (s.querySelector('.like-wrapper .count, .count') as HTMLElement | null)?.innerText.trim() ?? '',
      cover: (s.querySelector('img') as HTMLImageElement | null)?.src ?? '',
      video: !!s.querySelector('.play-icon, [class*="play"]'),
    });
  }
  return cards;
}

/** A Rednote note page: its full text and every image, from the page state or the DOM. */
export function readRednoteNote(id: string): { title: string; text: string; author: string; time: string; images: string[]; video: boolean; stats: Array<[string, string]>; tags: string[] } | null {
  const unwrap = (v: unknown): unknown => {
    let x = v as Record<string, unknown> | null;
    for (let i = 0; i < 4 && x && typeof x === 'object'; i++) {
      if ('_rawValue' in x) x = x._rawValue as Record<string, unknown>;
      else if ('_value' in x) x = x._value as Record<string, unknown>;
      else if ('value' in x && Object.keys(x).length <= 3) x = x.value as Record<string, unknown>;
      else break;
    }
    return x;
  };
  const state = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
  const noteState = unwrap(state?.note) as Record<string, unknown> | null;
  const map = unwrap(noteState?.noteDetailMap) as Record<string, unknown> | null;
  const entry = (map ? unwrap(map[id]) ?? unwrap(Object.values(map)[0]) : null) as Record<string, unknown> | null;
  const note = entry ? unwrap(entry.note) as Record<string, unknown> | null : null;
  if (note && (note.title || note.desc)) {
    const user = (unwrap(note.user) ?? {}) as Record<string, unknown>;
    const interact = (unwrap(note.interactInfo) ?? {}) as Record<string, unknown>;
    const imageList = (unwrap(note.imageList) ?? []) as Array<Record<string, unknown>>;
    const tagList = (unwrap(note.tagList) ?? []) as Array<Record<string, unknown>>;
    const stats: Array<[string, string]> = [];
    for (const [k, label] of [['likedCount', 'likes'], ['collectedCount', 'saves'], ['commentCount', 'comments']] as const) {
      if (interact[k] !== undefined && interact[k] !== '') stats.push([label, String(interact[k])]);
    }
    return {
      title: String(note.title ?? ''),
      text: String(note.desc ?? ''),
      author: String(user.nickname ?? ''),
      time: typeof note.time === 'number' ? new Date(note.time).toISOString() : '',
      images: (Array.isArray(imageList) ? imageList : []).map((i) => String(unwrap(i) && (unwrap(i) as Record<string, unknown>).urlDefault || (unwrap(i) as Record<string, unknown>)?.url || '')).filter(Boolean),
      video: note.type === 'video',
      stats,
      tags: (Array.isArray(tagList) ? tagList : []).map((t) => String((unwrap(t) as Record<string, unknown>)?.name ?? '')).filter(Boolean),
    };
  }
  const title = (document.querySelector('#detail-title, .note-content .title') as HTMLElement | null)?.innerText.trim() ?? '';
  const text = (document.querySelector('#detail-desc, .note-content .desc') as HTMLElement | null)?.innerText.trim() ?? '';
  if (!title && !text) return null;
  return {
    title,
    text,
    author: (document.querySelector('.author-wrapper .username, .author .name') as HTMLElement | null)?.innerText.trim() ?? '',
    time: '',
    images: Array.from(document.querySelectorAll('.swiper-slide img, .media-container img, .note-slider img')).map((i) => (i as HTMLImageElement).src).filter((s, i, all) => s && all.indexOf(s) === i),
    video: !!document.querySelector('video, .player-container'),
    stats: [],
    tags: [],
  };
}

/**
 * Rednote sends a visitor it does not trust to a captcha, a login page, or an error page whose
 * `error_msg` says why (its IP risk control).
 */
export function rednoteBlocked(): { kind: 'captcha' | 'login' | 'blocked'; detail: string } | null {
  const path = location.pathname;
  if (/website-login\/error/.test(path)) return { kind: 'blocked', detail: new URLSearchParams(location.search).get('error_msg') ?? '' };
  if (/captcha|verify|security/.test(path)) return { kind: 'captcha', detail: '' };
  if (/login/.test(path)) return { kind: 'login', detail: '' };
  return null;
}

/**
 * Posts found by page semantics: `article`, `[role="article"]`, `[aria-posinset]` and pressable
 * containers, the outermost of each; failing those, the smallest blocks around each
 * `time[datetime]`.
 */
export function readGenericPosts(opts: DomReadOptions): DomPost[] {
  const textWithout = (el: HTMLElement, junk: string): string => {
    const hidden = Array.from(el.querySelectorAll(junk)).map((e) => [e as HTMLElement, e.getAttribute('style')] as const);
    for (const [e] of hidden) e.style.setProperty('display', 'none', 'important');
    const text = el.innerText;
    for (const [e, style] of hidden) if (style === null) e.removeAttribute('style'); else e.setAttribute('style', style);
    return text;
  };
  const SELECTOR = 'article, [role="article"], [aria-posinset], div[data-pressable-container="true"]';
  let blocks = Array.from(document.querySelectorAll(SELECTOR)).filter((b) => !b.parentElement?.closest(SELECTOR));
  if (!blocks.length) {
    const found = new Set<Element>();
    for (const t of Array.from(document.querySelectorAll('time[datetime]'))) {
      let b: Element | null = t.parentElement;
      while (b && b !== document.body && ((b as HTMLElement).innerText ?? '').trim().length < 80) b = b.parentElement;
      if (b && b !== document.body && b.querySelectorAll('time[datetime]').length === 1) found.add(b);
    }
    blocks = Array.from(found).filter((b) => !Array.from(found).some((o) => o !== b && o.contains(b)));
  }
  const out: DomPost[] = [];
  for (const b of blocks) {
    const timeEl = b.querySelector('time');
    const links = Array.from(b.querySelectorAll('a[href]')).map((l) => (l as HTMLAnchorElement).href);
    const link = (timeEl?.closest('a') as HTMLAnchorElement | null)?.href
      ?? links.find((h) => /\/status\/|\/post\/|\/p\/|\/comments\/|\/posts\/|\/permalink\/|\/explore\/[0-9a-f]{24}|\/video\//.test(h))
      ?? '';
    const text = textWithout(b as HTMLElement, '[role="button"], button, svg, img, video, nav, form, textarea, script, style')
      .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
    const images = Array.from(b.querySelectorAll('img'))
      .map((img) => img as HTMLImageElement)
      .filter((img) => (img.width || img.naturalWidth || 0) >= opts.minImagePx && !/avatar|profile picture|头像/i.test(img.alt + img.className))
      .map((img) => ({ url: img.currentSrc || img.src, alt: img.alt }));
    if (!text && !images.length) continue;
    out.push({
      key: link || text.slice(0, 120),
      url: link,
      author: '',
      text,
      time: timeEl?.getAttribute('datetime') ?? '',
      timeText: '',
      images,
      video: !!b.querySelector('video'),
      stats: [],
      ad: Array.from(b.querySelectorAll('span, div, a, p')).some((e) => /^(Sponsored|Promoted|Ad|广告|赞助|赞助内容)$/.test((e.textContent ?? '').trim())),
      truncated: false,
    });
  }
  return out;
}

/** The main text of the page, for a post page no reader knows; `max` characters at most. */
export function readPageText(max: number): { title: string; text: string; truncated: boolean } {
  const root = (document.querySelector('main, [role="main"]') ?? document.body) as HTMLElement;
  const text = (root.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
  return { title: document.title, text: text.slice(0, max), truncated: text.length > max };
}

/** Scrolls the page by most of a screen; returns whether the page moved. */
export function scrollDown(): boolean {
  const before = window.scrollY;
  window.scrollBy(0, Math.round(window.innerHeight * 0.85));
  return window.scrollY !== before;
}
