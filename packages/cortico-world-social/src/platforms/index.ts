/** The adapter of each platform. */
import type { PlatformId } from '../posts.ts';
import type { Adapter } from './adapter.ts';
import { BILIBILI } from './bilibili.ts';
import { FACEBOOK } from './facebook.ts';
import { INSTAGRAM } from './instagram.ts';
import { REDDIT } from './reddit.ts';
import { REDNOTE } from './rednote.ts';
import { THREADS } from './threads.ts';
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
};

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
