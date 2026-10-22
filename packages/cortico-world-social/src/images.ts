/**
 * Reading the images of gathered posts, within the request's time: OCR on this machine, or the
 * image itself attached for the model (OCR instead when the model does not take that format). Each
 * image's outcome is written to its `read`, so the receipt says exactly what was and was not read.
 */
import { IMAGE_ACCEPT, Interrupted, type PageSession } from './browser.ts';
import type { Deadline } from './collect.ts';
import { OcrImageError, type Ocr, type OcrLanguage } from './ocr.ts';
import { ATTACHED_MAX, IMAGES_PER_POST, type Post } from './posts.ts';
/** Time kept back for rendering the receipt. */
const RESERVE_MS = 1500;

export interface ImageReadOptions {
  mode: 'ocr' | 'model';
  deadline: Deadline;
  ocr: Ocr;
  languages: OcrLanguage[];
  /** Whether the model in use takes images of this type. */
  accepts(mime: string): boolean;
  /** Attaches an image of post `post`, image `image` (both from 1); returns its number among the attachments. */
  attach(bytes: Uint8Array, mime: string, post: number, image: number): number;
}

/** Reads the images of `posts` in order; returns the OCR failure, if OCR could not run at all. */
export async function readImages(page: PageSession, posts: Post[], opts: ImageReadOptions): Promise<string | null> {
  let attached = 0;
  let ocrFailure: string | null = null;
  for (const [p, post] of posts.entries()) {
    for (const [i, image] of post.images.entries()) {
      if (i >= IMAGES_PER_POST) { image.read = { kind: 'unread', why: 'cap' }; continue; }
      if (opts.deadline.leftMs < RESERVE_MS) { image.read = { kind: 'unread', why: 'time' }; continue; }
      // once OCR cannot run, an image only OCR would read is not downloaded
      if (ocrFailure && (opts.mode === 'ocr' || attached >= ATTACHED_MAX)) { image.read = { kind: 'unread', why: 'ocr' }; continue; }
      const got = await page.fetchRaw(image.url, post.url || image.url, IMAGE_ACCEPT);
      if (!got || !got.mime.startsWith('image/')) { image.read = { kind: 'unread', why: 'download' }; continue; }
      if (opts.mode === 'model' && attached < ATTACHED_MAX && opts.accepts(got.mime)) {
        attached++;
        image.read = { kind: 'attached', n: opts.attach(got.bytes, got.mime, p + 1, i + 1) };
        continue;
      }
      if (ocrFailure) { image.read = { kind: 'unread', why: 'ocr' }; continue; }
      try {
        image.read = { kind: 'ocr', text: await opts.ocr.read(got.bytes, opts.languages) };
      } catch (err) {
        if (err instanceof Interrupted) throw err;
        if (err instanceof OcrImageError) { image.read = { kind: 'unread', why: 'decode' }; continue; }
        ocrFailure = err instanceof Error ? err.message : String(err);
        image.read = { kind: 'unread', why: 'ocr' };
      }
    }
  }
  return ocrFailure;
}
