/** config.ts: the settings form's schema over `worlds.social`, and the autoscroll job list. */
import { describe, expect, it } from 'vitest';
import { coerceGroupValues, getByPath, readGroupValues } from 'cortico/core/config-schema.ts';
import { LANGUAGES } from 'cortico/core/language.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import {
  IMAGE_MODES, JOB_POSTS_CAP, MAX_JOBS, MAX_POSTS_CAP, MAX_SEC_CAP, SOCIAL_DEFAULTS, SOCIAL_ID, parseJobs, socialConfigGroup, type AutoscrollJob,
} from '../src/config.ts';

const PREFIX = `worlds.${SOCIAL_ID}.`;

/** Dotted paths of the scalar values under `v`; a list counts as one value. */
const leaves = (v: unknown, path = ''): string[] =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k))
    : [path];

const cfgOf = (section: unknown) => ({ worlds: { [SOCIAL_ID]: section } }) as unknown as CoreConfig;

describe('socialConfigGroup', () => {
  const group = socialConfigGroup('en');
  const props = group.schema.properties;

  it('declares every scalar setting of the section, the World switch and the job list apart', () => {
    const settings = leaves(SOCIAL_DEFAULTS).filter((p) => p !== 'enabled' && p !== 'autoscroll.jobs');
    expect(new Set(Object.keys(props))).toEqual(new Set(settings.map((p) => PREFIX + p)));
    expect(group.id).toBe(`world:${SOCIAL_ID}`);
  });

  it('declares each setting with the type of its default, applied without a restart', () => {
    for (const [path, prop] of Object.entries(props)) {
      const value = getByPath(cfgOf(SOCIAL_DEFAULTS) as unknown as Record<string, unknown>, path);
      const type = typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
      expect(prop.type, path).toBe(type);
      expect(prop['x-hot'], path).toBe(true);
    }
    expect(props[`${PREFIX}images`].enum).toEqual([...IMAGE_MODES]);
    expect(props[`${PREFIX}maxPosts`].maximum).toBe(MAX_POSTS_CAP);
    expect(props[`${PREFIX}maxSec`].maximum).toBe(MAX_SEC_CAP);
  });

  it('accepts the defaults as they are, and refuses a value past a cap', () => {
    const values = readGroupValues(cfgOf(SOCIAL_DEFAULTS), group);
    expect(coerceGroupValues(group, values, 'en')).toEqual({ values });
    expect(coerceGroupValues(group, { [`${PREFIX}maxPosts`]: MAX_POSTS_CAP + 1 }, 'en')).toHaveProperty('error');
    expect(coerceGroupValues(group, { [`${PREFIX}images`]: 'everything' }, 'en')).toHaveProperty('error');
  });

  it('has a title for the group and every setting in every app language', () => {
    for (const language of LANGUAGES) {
      const g = socialConfigGroup(language);
      expect(g.schema.title.trim(), language).not.toBe('');
      for (const [path, prop] of Object.entries(g.schema.properties)) expect(prop.title.trim(), `${language} ${path}`).not.toBe('');
    }
  });
});

describe('parseJobs', () => {
  const job: AutoscrollJob = { platform: 'reddit', source: 'community', query: 'r/fixturetown', maxPosts: 50, at: '08:30', images: 'skip' };

  it('keeps valid jobs as they are', () => {
    const feed: AutoscrollJob = { platform: 'youtube', source: 'feed', query: '', maxPosts: 10, at: '23:59', images: 'ocr' };
    expect(parseJobs([job, feed])).toEqual([job, feed]);
  });

  it('reads a job whose images are not skipped with OCR, the model setting included: a digest is read later as text', () => {
    expect(parseJobs([{ ...job, images: 'model' }, { ...job, at: '09:00', images: 'anything' }]).map((j) => j.images)).toEqual(['ocr', 'ocr']);
  });

  it('reads anything that is not a list as no jobs', () => {
    for (const raw of [undefined, null, 'jobs', { 0: job }]) expect(parseJobs(raw)).toEqual([]);
  });

  it('drops entries with an unknown platform or source, a malformed time, no count, or no query for a non-feed source', () => {
    const bad: unknown[] = [
      null,
      'job',
      { ...job, platform: 'myspace' },
      { ...job, source: 'trending' },
      ...['24:00', '8:30', '08:60', '0830', '', undefined].map((at) => ({ ...job, at })),
      ...[0, -3, 'many', Number.NaN, undefined].map((maxPosts) => ({ ...job, maxPosts })),
      ...['search', 'account', 'community'].map((source) => ({ ...job, source, query: '   ' })),
      { ...job, query: 42 },
    ];
    expect(parseJobs([...bad, job])).toEqual([job]);
  });

  it('clears the query of a feed job and trims the others to 200 characters', () => {
    expect(parseJobs([{ ...job, source: 'feed', query: 'ignored' }])[0].query).toBe('');
    expect(parseJobs([{ ...job, source: 'search', query: '  ramen  ' }])[0].query).toBe('ramen');
    expect(parseJobs([{ ...job, source: 'search', query: 'q'.repeat(250) }])[0].query).toBe('q'.repeat(200));
  });

  it('rounds the count and caps it', () => {
    expect(parseJobs([{ ...job, maxPosts: 2.6 }])[0].maxPosts).toBe(3);
    expect(parseJobs([{ ...job, maxPosts: '12' }])[0].maxPosts).toBe(12);
    expect(parseJobs([{ ...job, maxPosts: JOB_POSTS_CAP + 1 }])[0].maxPosts).toBe(JOB_POSTS_CAP);
  });

  it('reads an unknown image setting as the default one', () => {
    expect(parseJobs([{ ...job, images: 'all' }])[0].images).toBe(SOCIAL_DEFAULTS.images);
    expect(parseJobs([{ ...job, images: undefined }])[0].images).toBe(SOCIAL_DEFAULTS.images);
  });

  it(`keeps at most ${MAX_JOBS} valid jobs, counting only valid ones`, () => {
    const many = Array.from({ length: MAX_JOBS + 3 }, (_, i) => ({ ...job, at: `0${i % 10}:${String(i).padStart(2, '0')}` }));
    const parsed = parseJobs([{ ...job, platform: 'nope' }, ...many]);
    expect(parsed).toHaveLength(MAX_JOBS);
    expect(parsed).toEqual(many.slice(0, MAX_JOBS));
  });
});
