/**
 * Writing through a platform's own page, for the platforms whose web API the bot does not call: the
 * box is clicked (after a click that opens it, where the page shows a placeholder first), the text
 * typed into it key by key, and the send button clicked, or Enter pressed where the platform sends
 * on Enter. The platform's own request that carries the text, whatever its address, is watched for:
 * its answer is the proof the text went out, and names the new comment or post where it does. Text
 * that went out without an answer may be up, and throws `TimeUp`.
 */
import { TimeUp, type FetchedText, type PageSession } from '../browser.ts';
import { PlatformBlocked } from '../collect.ts';
import { CommentRefused } from '../comments.ts';
import type { PlatformId } from '../posts.ts';

export interface ComposeSteps {
  /** Clicked first, the first of them that shows, where the page shows the box only after a click. */
  open?: readonly string[];
  /** The box to type into. */
  box: string;
  /** The button that sends; Enter sends when absent. */
  send?: string;
  /** The addresses the platform sends text to; the request is the one among them whose body carries the text. */
  request: RegExp;
  /** The box holds the text already (a share intent filled it): it is not typed. */
  filled?: boolean;
}

/** Time a box or a button may take to show. */
const SHOW_MS = 8_000;
/** Time the platform may take to answer the request that sends. */
const ANSWER_MS = 15_000;
/** A page a platform sends a visitor without a login to. */
const LOGIN_PAGE = /\/(login|signin|sign_in|accounts\/login|i\/flow\/login|checkpoint)\b/i;
/** Most characters of the text's first word looked for in the request that sends it. */
const CARRIED_CHARS = 12;
/** A run of letters and digits: the only characters every encoding of a request body keeps the same, but for escapes. */
const WORD = /[\p{L}\p{N}]+/gu;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern for a request body that carries `text`: its first run of four letters or digits or more
 * (else its first run), as typed, URL-encoded or JSON-escaped, the escapes alone or within a form;
 * letter case aside, as escapes differ in it. Spaces and punctuation are left out: a form and
 * `encodeURIComponent` encode them differently.
 */
export function carries(text: string): RegExp {
  const words = text.match(WORD) ?? [];
  const word = words.find((w) => Array.from(w).length >= 4) ?? words[0] ?? '';
  const start = Array.from(word).slice(0, CARRIED_CHARS).join('');
  const json = JSON.stringify(start).slice(1, -1);
  const asciiJson = json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const forms = [start, json, asciiJson, encodeURIComponent(start), encodeURIComponent(json), encodeURIComponent(asciiJson)];
  return new RegExp([...new Set(forms)].map(escapeRegExp).join('|'), 'i');
}

/** Types `text` into the box `steps` name and sends it; the platform's answer to the request that carried it. */
export async function compose(page: PageSession, platform: PlatformId, steps: ComposeSteps, text: string): Promise<FetchedText> {
  for (const open of steps.open ?? []) if (await page.click(open, SHOW_MS)) break;
  if (!(await page.click(steps.box, SHOW_MS))) {
    if (LOGIN_PAGE.test(page.url())) throw new PlatformBlocked(platform, 'login');
    throw new CommentRefused(platform, 'no text box showed on the page; it may need a login, or the page changed');
  }
  if (!steps.filled) await page.type(text);
  let sent = true;
  const answer = await page.captureResponse(steps.request, async () => {
    if (steps.send) sent = await page.click(steps.send, SHOW_MS);
    else await page.press('Enter');
  }, ANSWER_MS, carries(text));
  if (!sent) throw new CommentRefused(platform, 'no send button showed on the page');
  if (!answer) throw new TimeUp();
  if (answer.status === 401 || answer.status === 403) throw new PlatformBlocked(platform, 'login');
  if (answer.status === 429) throw new PlatformBlocked(platform, 'blocked', 'HTTP 429, too many requests');
  if (answer.status >= 400) throw new CommentRefused(platform, `HTTP ${answer.status}`);
  return answer;
}

/** The first non-empty string or number under `key` anywhere in `json`, depth first; null when there is none. */
export function findKey(json: unknown, key: string): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (!Array.isArray(v)) {
      const own = (v as Record<string, unknown>)[key];
      if ((typeof own === 'string' && own) || typeof own === 'number') return String(own);
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(json);
}

/** `text` parsed as JSON, or null; a platform may put a prefix such as `for (;;);` before it. */
export function jsonOf(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/** Selectors for a button whose own text is one of `labels`, the platform's word for it in each language it may show. */
export const labelled = (scope: string, tag: string, labels: readonly string[]): string =>
  labels.map((l) => `${scope} ${tag}:text-is(${JSON.stringify(l)})`).join(', ');
