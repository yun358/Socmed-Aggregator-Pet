/** ocr.ts: which OCR languages a read uses, and downloading their data with checksum checks. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LANGUAGES } from 'cortico/core/language.ts';
import { OCR_LANGUAGES, Ocr, ocrLanguagesFor, type OcrLanguage } from '../src/ocr.ts';
import { PLATFORM_IDS } from '../src/posts.ts';

/** The real English data, kept by hand under scratch/ (gitignored); the download success case runs only where it exists. */
const ENG_GZ = fileURLToPath(new URL('../../../scratch/tessdata/eng.traineddata.gz', import.meta.url));

describe('ocrLanguagesFor', () => {
  it('reads English everywhere, plus the script of the app language, each language once and all of them known', () => {
    for (const language of LANGUAGES) {
      for (const platform of PLATFORM_IDS) {
        const langs = ocrLanguagesFor(language, platform);
        expect(langs[0], `${language} ${platform}`).toBe('eng');
        expect(new Set(langs).size, `${language} ${platform}`).toBe(langs.length);
        for (const l of langs) expect(OCR_LANGUAGES, `${language} ${platform}`).toHaveProperty(l);
      }
    }
    expect(ocrLanguagesFor('en', 'reddit')).toEqual(['eng']);
    expect(ocrLanguagesFor('ja', 'x')).toEqual(['eng', 'jpn']);
    expect(ocrLanguagesFor('zh-Hant', 'threads')).toEqual(['eng', 'chi_tra']);
  });

  it('adds Simplified Chinese on Bilibili and Rednote whatever the app language', () => {
    expect(ocrLanguagesFor('en', 'rednote')).toEqual(['eng', 'chi_sim']);
    expect(ocrLanguagesFor('fr', 'bilibili')).toEqual(['eng', 'fra', 'chi_sim']);
    expect(ocrLanguagesFor('zh', 'bilibili')).toEqual(['eng', 'chi_sim']);
  });
});

describe('Ocr.ensure', () => {
  let dir: string;
  beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'social-ocr-')), 'social'); });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  /** A fetch that answers the mirrors in order from `answers` and records the URLs asked for. */
  const scripted = (answers: Array<Response | Error>) => {
    const urls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      const a = answers[urls.length - 1];
      if (!a) throw new Error('no more answers');
      if (a instanceof Error) throw a;
      return a;
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  };
  const bytes = (b: Buffer | Uint8Array) => new Response(new Uint8Array(b));

  it('makes no request for a language already on disk', async () => {
    const { urls, fetch } = scripted([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'eng.traineddata'), 'present');
    await new Ocr({ dataDir: dir, fetch }).ensure(['eng']);
    expect(urls).toEqual([]);
    expect(readFileSync(join(dir, 'eng.traineddata'), 'utf8')).toBe('present');
  });

  it('gives an error naming the language and every mirror that failed, and leaves no file behind', async () => {
    const { urls, fetch } = scripted([
      new Response('gone', { status: 404 }),
      bytes(gzipSync(Buffer.from('not the published data'))),
      new Error('connection reset'),
    ]);
    const ocr = new Ocr({ dataDir: dir, fetch });
    const failure = await ocr.ensure(['kor']).then(() => null, (err: Error) => err.message);
    expect(failure).toContain('kor');
    expect(failure).toContain('HTTP 404');
    expect(failure).toContain('checksum mismatch');
    expect(failure).toContain('connection reset');
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) expect(url).toContain('kor.traineddata.gz');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(!existsSync(ENG_GZ))('moves to the next mirror after a checksum mismatch and unpacks the valid file to <lang>.traineddata', async () => {
    const gz = readFileSync(ENG_GZ);
    const { urls, fetch } = scripted([bytes(Buffer.from('tampered')), bytes(gz)]);
    const ocr = new Ocr({ dataDir: dir, fetch });
    await ocr.ensure(['eng'] satisfies OcrLanguage[]);
    expect(urls).toHaveLength(2);
    expect(readFileSync(join(dir, 'eng.traineddata')).equals(gunzipSync(gz))).toBe(true);
    expect(readdirSync(dir)).toEqual(['eng.traineddata']);
  });
});
