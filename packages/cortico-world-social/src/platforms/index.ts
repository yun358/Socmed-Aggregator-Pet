/** The adapter of each platform, and what the bot may write on each. */
import { AUTO_LINE, type WriteKind } from '../comments.ts';
import { PLATFORM_IDS, type PlatformId } from '../posts.ts';
import type { Adapter } from './adapter.ts';
import { BILIBILI } from './bilibili.ts';
import { FACEBOOK } from './facebook.ts';
import { INSTAGRAM } from './instagram.ts';
import { NEWS } from './news.ts';
import { REDDIT } from './reddit.ts';
import { REDNOTE } from './rednote.ts';
import { SUBSTACK, SUBSTACK_TEXT_MAX } from './substack.ts';
import { THREADS } from './threads.ts';
import { WEB } from './web.ts';
import { X } from './x.ts';
import { YOUTUBE } from './youtube.ts';

export const ADAPTERS: Record<PlatformId, Adapter> = {
  reddit: REDDIT,
  x: X,
  facebook: FACEBOOK,
  threads: THREADS,
  instagram: INSTAGRAM,
  youtube: YOUTUBE,
  bilibili: BILIBILI,
  rednote: REDNOTE,
  substack: SUBSTACK,
  news: NEWS,
  web: WEB,
};

/** The platforms the bot writes new posts on; Substack's posts are Notes. It comments wherever an adapter has a writer. */
export const POST_PLATFORMS: readonly PlatformId[] = PLATFORM_IDS.filter((p) => ADAPTERS[p].write?.posts);

/** Whether a platform has logins at all; Google News and the web need none. */
export const hasLogin = (platform: PlatformId): boolean => ADAPTERS[platform].session.cookies.length > 0;

/** How long `text` is as `platform` counts it. */
export const lengthOn = (platform: PlatformId, text: string): number => ADAPTERS[platform].write?.length?.(text) ?? text.length;

/** The line automatic comments, posts and Notes on `platform` end with while they are marked. */
export const markOf = (platform: PlatformId, kind: WriteKind): string => (kind === 'note' ? AUTO_LINE : ADAPTERS[platform].write?.mark ?? AUTO_LINE);

/** The longest `kind` the platform takes, as `lengthOn` counts; what the bot writes leaves room for the mark and the blank line before it. */
export function limitOf(platform: PlatformId, kind: WriteKind, bot: boolean): number {
  const w = ADAPTERS[platform].write;
  const max = kind === 'note' ? SUBSTACK_TEXT_MAX : kind === 'post' ? w?.posts?.max ?? 0 : w?.commentMax ?? 0;
  return bot ? max - lengthOn(platform, markOf(platform, kind)) - 2 : max;
}

/** The platform a post URL belongs to; null for any other site. */
export function platformOf(url: string): PlatformId | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return (Object.values(ADAPTERS).find((a) => a.owns(u))?.id) ?? null;
}

export type { Adapter, BrowseRequest, PostDetail, TranscriptResult } from './adapter.ts';
