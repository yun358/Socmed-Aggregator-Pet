/**
 * The text this World shows people, one file per language named for its code. `zh.ts` and `en.ts`
 * have every key; another language's file has the top-level keys translated so far, each group in it
 * whole, and the keys it leaves out read `zh.ts` for `zh-Hant` and `en.ts` for the rest. Imports
 * nothing from Cortico at run time, so the panel (src/webui/client.ts) uses it too.
 */
import type { Language, LanguageTable } from 'cortico/core/language.ts';
import zh from './zh.ts';
import en from './en.ts';
import zhHant from './zh-Hant.ts';
import ja from './ja.ts';
import ko from './ko.ts';
import fr from './fr.ts';
import de from './de.ts';
import es419 from './es-419.ts';
import ptBR from './pt-BR.ts';
import it from './it.ts';
import ru from './ru.ts';

export type SocialText = typeof zh;

export const SOCIAL_TEXT: LanguageTable<SocialText> = { zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru };

/** The table of `language`; `zh` when absent. Cortico's `pick` written out for the panel bundle. */
export function socialText(language: Language = 'zh'): SocialText {
  const base = SOCIAL_TEXT[language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en'];
  const own = language === 'zh' || language === 'en' ? undefined : SOCIAL_TEXT[language];
  if (!own) return base;
  return { ...base, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) };
}
