/**
 * The `worlds.social` config section. Every key is read at use, so a change in the settings window
 * applies to the next read. The autoscroll jobs are a list, which `/api/config` cannot write; the
 * settings window writes them through the `social` panel's `setJobs` method.
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { socialText } from './i18n/index.ts';
import { PLATFORM_IDS, type PlatformId, type SourceKind } from './posts.ts';

export const SOCIAL_ID = 'social';

/** How images in posts are read: OCR on this machine, shown to the model, or posts with images skipped (text only). */
export const IMAGE_MODES = ['ocr', 'model', 'skip'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

export const SOURCE_KINDS: readonly SourceKind[] = ['feed', 'search', 'account', 'community'];

export interface AutoscrollJob {
  platform: PlatformId;
  source: SourceKind;
  /** Search terms, account or community; empty for the feed. */
  query: string;
  /** Posts to read each day. */
  maxPosts: number;
  /** Local time of day to start, `HH:MM`. */
  at: string;
  /** A digest is read later as text, so its images are read with OCR or the posts with them skipped. */
  images: JobImageMode;
}

export type JobImageMode = Exclude<ImageMode, 'model'>;

export interface SocialConfigSection extends WorldSection {
  /** Posts the bot may read for one request, across all its reads in that turn. */
  maxPosts: number;
  /** Seconds the bot may spend reading for one request. */
  maxSec: number;
  images: ImageMode;
  /** Characters of a transcript one call returns; the rest is read with `from_sec`. */
  maxTranscriptChars: number;
  /** Show the browser window while the bot reads. */
  showBrowser: boolean;
  /** The browser executable; empty finds an installed Chrome, Edge, Brave or Chromium. */
  browserFile: string;
  platforms: Record<PlatformId, { enabled: boolean }>;
  autoscroll: {
    enabled: boolean;
    /** Minutes one job may take before it stops with what it has read. */
    maxMinutes: number;
    jobs: AutoscrollJob[];
  };
  /** Comments the bot drafts for the person to post (`comments.ts`). */
  comments: {
    enabled: boolean;
    /** Comments the person may post in one day, by the local date. */
    maxPerDay: number;
  };
}

export const MAX_POSTS_CAP = 100;
export const MAX_SEC_CAP = 1800;
export const MAX_JOBS = 8;
export const JOB_POSTS_CAP = 300;
export const COMMENTS_PER_DAY_CAP = 50;

export const SOCIAL_DEFAULTS: SocialConfigSection = {
  enabled: false,
  maxPosts: 5,
  maxSec: 120,
  images: 'ocr',
  maxTranscriptChars: 30000,
  showBrowser: false,
  browserFile: '',
  platforms: Object.fromEntries(PLATFORM_IDS.map((id) => [id, { enabled: true }])) as Record<PlatformId, { enabled: boolean }>,
  autoscroll: { enabled: false, maxMinutes: 15, jobs: [] },
  comments: { enabled: false, maxPerDay: 10 },
};

const K = `worlds.${SOCIAL_ID}`;

/** The settings the WebUI form edits; the job list goes through the panel. */
export function socialConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = socialText(language).config;
  return {
    id: `world:${SOCIAL_ID}`,
    owner: `world:${SOCIAL_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      properties: {
        [`${K}.maxPosts`]: { type: 'integer', title: c.maxPosts.title, description: c.maxPosts.description, minimum: 1, maximum: MAX_POSTS_CAP, 'x-hot': true },
        [`${K}.maxSec`]: { type: 'integer', title: c.maxSec.title, description: c.maxSec.description, minimum: 10, maximum: MAX_SEC_CAP, 'x-suffix': 's', 'x-hot': true },
        [`${K}.images`]: { type: 'string', title: c.images.title, description: c.images.description, enum: [...IMAGE_MODES], 'x-hot': true },
        [`${K}.maxTranscriptChars`]: { type: 'integer', title: c.maxTranscriptChars.title, description: c.maxTranscriptChars.description, minimum: 2000, maximum: 200000, 'x-hot': true },
        [`${K}.showBrowser`]: { type: 'boolean', title: c.showBrowser.title, description: c.showBrowser.description, 'x-hot': true },
        [`${K}.browserFile`]: { type: 'string', title: c.browserFile.title, description: c.browserFile.description, 'x-hot': true },
        ...Object.fromEntries(PLATFORM_IDS.map((id) => [`${K}.platforms.${id}.enabled`, { type: 'boolean', title: c.platformEnabled(socialText(language).platforms[id]), 'x-hot': true }])),
        [`${K}.autoscroll.enabled`]: { type: 'boolean', title: c.autoscrollEnabled.title, description: c.autoscrollEnabled.description, 'x-hot': true },
        [`${K}.autoscroll.maxMinutes`]: { type: 'integer', title: c.autoscrollMaxMinutes.title, description: c.autoscrollMaxMinutes.description, minimum: 1, maximum: 120, 'x-hot': true },
        [`${K}.comments.enabled`]: { type: 'boolean', title: c.commentsEnabled.title, description: c.commentsEnabled.description, 'x-hot': true },
        [`${K}.comments.maxPerDay`]: { type: 'integer', title: c.commentsPerDay.title, description: c.commentsPerDay.description, minimum: 1, maximum: COMMENTS_PER_DAY_CAP, 'x-hot': true },
      },
    },
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `raw` as a job list: entries that are not valid jobs are dropped, at most `MAX_JOBS` kept. */
export function parseJobs(raw: unknown): AutoscrollJob[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoscrollJob[] = [];
  for (const j of raw) {
    if (out.length >= MAX_JOBS) break;
    if (typeof j !== 'object' || j === null) continue;
    const r = j as Record<string, unknown>;
    if (!(PLATFORM_IDS as readonly string[]).includes(String(r.platform))) continue;
    if (!SOURCE_KINDS.includes(r.source as SourceKind)) continue;
    const at = String(r.at ?? '');
    if (!TIME.test(at)) continue;
    const n = Math.round(Number(r.maxPosts));
    if (!Number.isFinite(n) || n < 1) continue;
    const query = typeof r.query === 'string' ? r.query.trim().slice(0, 200) : '';
    if (r.source !== 'feed' && !query) continue;
    out.push({
      platform: r.platform as PlatformId,
      source: r.source as SourceKind,
      query: r.source === 'feed' ? '' : query,
      maxPosts: Math.min(n, JOB_POSTS_CAP),
      at,
      images: r.images === 'skip' ? 'skip' : 'ocr',
    });
  }
  return out;
}
