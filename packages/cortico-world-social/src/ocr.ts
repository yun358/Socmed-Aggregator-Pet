/**
 * Reads the text in post images with Tesseract (tesseract.js, WebAssembly, on this machine). The
 * language data is downloaded once per language into `<models>/social/`, checked against its
 * published SHA-256; Core's `fetch` downloads it, so the system proxy applies. One worker serves
 * one language set at a time and is released after `IDLE_MS` without use.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Worker } from 'tesseract.js';
import { joinCjk, type PlatformId } from './posts.ts';

/** Tesseract language codes with the published size and SHA-256 of their `.traineddata.gz`. */
export const OCR_LANGUAGES = {
  eng: { bytes: 2952873, sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' },
  chi_sim: { bytes: 1718768, sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c' },
  chi_tra: { bytes: 1656239, sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743' },
  jpn: { bytes: 2030256, sha256: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88' },
  kor: { bytes: 1572336, sha256: '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126' },
  fra: { bytes: 707406, sha256: 'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255' },
  deu: { bytes: 1333102, sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b' },
  spa: { bytes: 2100190, sha256: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb' },
  por: { bytes: 1392239, sha256: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c' },
  ita: { bytes: 1660998, sha256: 'f702fcfad297ce028ede3626d1467b67939f23ff23595f9badd54681cf25a4d3' },
  rus: { bytes: 2679598, sha256: 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a' },
} as const;
export type OcrLanguage = keyof typeof OCR_LANGUAGES;

/** Mirrors of the `@tesseract.js-data/<lang>@1.0.0` packages, tried in order; npmmirror serves mainland China. */
const MIRRORS = [
  (lang: string) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int/${lang}.traineddata.gz`,
  (lang: string) => `https://unpkg.com/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int/${lang}.traineddata.gz`,
  (lang: string) => `https://registry.npmmirror.com/@tesseract.js-data/${lang}/1.0.0/files/4.0.0_best_int/${lang}.traineddata.gz`,
];

const APP_LANGUAGE_OCR: Record<string, OcrLanguage> = {
  zh: 'chi_sim', 'zh-Hant': 'chi_tra', ja: 'jpn', ko: 'kor', fr: 'fra', de: 'deu', 'es-419': 'spa', 'pt-BR': 'por', it: 'ita', ru: 'rus',
};

/** Platforms whose posts are mostly Simplified Chinese whatever the app language. */
const CHINESE_PLATFORMS: ReadonlySet<PlatformId> = new Set(['bilibili', 'rednote']);

/** English, the app language's script, and Simplified Chinese for the Chinese platforms. */
export function ocrLanguagesFor(appLanguage: string, platform: PlatformId): OcrLanguage[] {
  const set = new Set<OcrLanguage>(['eng']);
  const own = APP_LANGUAGE_OCR[appLanguage];
  if (own) set.add(own);
  if (CHINESE_PLATFORMS.has(platform)) set.add('chi_sim');
  return [...set];
}

const IDLE_MS = 5 * 60_000;
/** Lines Tesseract reads with less confidence than this (0–100) are noise from photos. */
const MIN_LINE_CONFIDENCE = 55;

export interface OcrOptions {
  /** Where the language data lives: `<models>/social`. */
  dataDir: string;
  fetch?: typeof fetch;
}

/** Tesseract could not decode one image; the next image is read as usual. */
export class OcrImageError extends Error {}

export class Ocr {
  private worker: Worker | null = null;
  private workerKey = '';
  private idle: NodeJS.Timeout | null = null;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: OcrOptions) {}

  /** Downloads the language files not yet on disk. */
  async ensure(languages: OcrLanguage[]): Promise<void> {
    mkdirSync(this.opts.dataDir, { recursive: true });
    for (const lang of languages) {
      const file = join(this.opts.dataDir, `${lang}.traineddata`);
      if (existsSync(file)) continue;
      const gz = await this.download(lang);
      const partial = `${file}.partial`;
      writeFileSync(partial, gunzipSync(gz));
      renameSync(partial, file);
    }
  }

  private async download(lang: OcrLanguage): Promise<Buffer> {
    const want = OCR_LANGUAGES[lang];
    const errors: string[] = [];
    for (const mirror of MIRRORS) {
      const url = mirror(lang);
      try {
        const rep = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
        if (!rep.ok) { errors.push(`${url}: HTTP ${rep.status}`); continue; }
        const bytes = Buffer.from(await rep.arrayBuffer());
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== want.sha256) { errors.push(`${url}: checksum mismatch`); continue; }
        return bytes;
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    throw new Error(`OCR data for ${lang} could not be downloaded (${errors.join('; ')})`);
  }

  /** The text in `image`, lines Tesseract is unsure of left out; '' when it found none. */
  async read(image: Uint8Array, languages: OcrLanguage[]): Promise<string> {
    // one recognition at a time: the worker is single-threaded and switching languages recreates it
    const run = this.pending.then(() => this.recognize(image, languages));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async recognize(image: Uint8Array, languages: OcrLanguage[]): Promise<string> {
    await this.ensure(languages);
    const worker = await this.workerFor(languages);
    this.armIdle();
    let data: Awaited<ReturnType<Worker['recognize']>>['data'];
    try {
      ({ data } = await worker.recognize(Buffer.from(image), {}, { blocks: true, text: true }));
    } catch (err) {
      // tesseract.js rejects with the worker's message, a string
      throw new OcrImageError(typeof err === 'string' ? err : (err as Error).message);
    }
    const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
      .filter((l) => l.confidence >= MIN_LINE_CONFIDENCE)
      .map((l) => joinCjk(l.text.trim()))
      .filter((l) => /[\p{L}\p{N}]{2,}/u.test(l));
    return lines.join('\n');
  }

  private async workerFor(languages: OcrLanguage[]): Promise<Worker> {
    const key = [...languages].sort().join('+');
    if (this.worker && this.workerKey === key) return this.worker;
    await this.release();
    const { createWorker, OEM } = await import('tesseract.js');
    this.worker = await createWorker(languages, OEM.LSTM_ONLY, {
      langPath: this.opts.dataDir,
      cachePath: this.opts.dataDir,
      cacheMethod: 'readOnly',
      gzip: false,
      // without a handler tesseract.js also throws a failed job's error where nothing can catch it
      errorHandler: () => {},
    });
    this.workerKey = key;
    return this.worker;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.release(), IDLE_MS);
    this.idle.unref();
  }

  async release(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const w = this.worker;
    this.worker = null;
    this.workerKey = '';
    if (w) await w.terminate().catch(() => undefined);
  }

  /** Removes the downloaded language files; the next read downloads them again. */
  clear(): void {
    rmSync(this.opts.dataDir, { recursive: true, force: true });
  }
}
