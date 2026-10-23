/**
 * Text of the coopanion World's panels, read by the panel bundle (client.ts) and by the World for
 * the panel's title. Imports nothing at run time outside this folder, so it bundles for the browser.
 * A language without a key reads `zh`'s for `zh-Hant` and `en`'s for the rest.
 */
import type { Language } from 'cortico/core/language.ts';
import { S as zhHant } from './strings.zh-Hant.ts';
import { S as ja } from './strings.ja.ts';
import { S as ko } from './strings.ko.ts';
import { S as fr } from './strings.fr.ts';
import { S as de } from './strings.de.ts';
import { S as es419 } from './strings.es-419.ts';
import { S as ptBR } from './strings.pt-BR.ts';
import { S as it } from './strings.it.ts';
import { S as ru } from './strings.ru.ts';

const zh = {
  title: '闹钟',
  desc: 'Coo 给自己设的闹钟。在这里删除后，Coo 会收到通知。',
  head: ['时间', '内容', '设定于', ''] as readonly string[],
  daily: '每天',
  empty: 'Coo 现在没有设闹钟。',
  remove: '删除',
  confirmTitle: (when: string) => `删除 ${when} 的闹钟？`,
  removed: '已删除',
  failed: (msg: string) => `删除失败：${msg}`,
  loadFailed: (msg: string) => `读取失败：${msg}`,
  conversations: {
    title: '对话记录',
    sheet: '存下的对话',
    messages: (n: number) => `${n} 条消息`,
    desc: '像聊天应用那样存下和 Coo 的对话、开始新对话，或回到存下的对话。最近几段 Coo 自己能打开；任何一段都能在这里打开。',
    enabled: '保存对话',
    enabledHint: '关闭后对话一直连着，不再存档。',
    recent: 'Coo 能打开的过往对话',
    recentSuffix: '段',
    current: '当前对话',
    currentEmpty: '还没说什么。',
    newConversation: '开始新对话',
    head: ['标题', '开始', '最后使用', '消息', ''] as readonly string[],
    cooCan: 'Coo 能打开',
    open: '打开',
    remove: '删除',
    confirmNew: '存下当前对话并开始新对话？',
    confirmOpen: (title: string) => `存下当前对话并回到「${title}」？`,
    confirmDelete: (title: string) => `删除「${title}」？删除后无法恢复。`,
    switching: '等 Coo 说完这一轮就切换…',
    empty: '还没有存下的对话。',
    off: '保存对话已关闭。',
    busy: '已经在切换了。',
    missing: '这段对话已不存在。',
    notReady: '应用还没准备好，稍后再试。',
    failed: (msg: string) => `没能完成：${msg}`,
    loadFailed: (msg: string) => `读取失败：${msg}`,
    outOfRange: (max: number) => `请填写 0 到 ${max} 之间的整数`,
  },
};

export const en: typeof zh = {
  title: 'Alarms',
  desc: 'Alarms Coo has set for itself. Coo is told when you delete one here.',
  head: ['Time', 'Note', 'Set at', ''],
  daily: 'Daily',
  empty: 'Coo has no alarms set.',
  remove: 'Delete',
  confirmTitle: (when) => `Delete the alarm at ${when}?`,
  removed: 'Deleted',
  failed: (msg) => `Could not delete: ${msg}`,
  loadFailed: (msg) => `Could not load: ${msg}`,
  conversations: {
    title: 'Conversations',
    sheet: 'Saved conversations',
    messages: (n) => `${n} message${n === 1 ? '' : 's'}`,
    desc: 'Save your conversation with Coo and start a new one, as in a chat app, or go back to a saved one. Coo can open the most recent ones itself; any of them opens here.',
    enabled: 'Save conversations',
    enabledHint: 'Off, the conversation runs on as one and nothing is saved.',
    recent: 'Past conversations Coo can open',
    recentSuffix: 'most recent',
    current: 'Current conversation',
    currentEmpty: 'Nothing said yet.',
    newConversation: 'New conversation',
    head: ['Title', 'Started', 'Last used', 'Messages', ''],
    cooCan: 'Coo can open',
    open: 'Open',
    remove: 'Delete',
    confirmNew: 'Save this conversation and start a new one?',
    confirmOpen: (title) => `Save the current conversation and go back to "${title}"?`,
    confirmDelete: (title) => `Delete "${title}"? This cannot be undone.`,
    switching: 'Switching once Coo finishes its turn…',
    empty: 'No saved conversations yet.',
    off: 'Saving conversations is off.',
    busy: 'A switch is already on its way.',
    missing: 'That conversation is gone.',
    notReady: 'The app is not ready yet; try again in a moment.',
    failed: (msg) => `Could not do that: ${msg}`,
    loadFailed: (msg) => `Could not load: ${msg}`,
    outOfRange: (max) => `Enter a whole number from 0 to ${max}`,
  },
};

export type PanelText = typeof en;

const OWN: Partial<Record<Language, Partial<PanelText>>> = { 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru };

export function panelText(language: Language = 'zh'): PanelText {
  const base = language === 'zh' || language === 'zh-Hant' ? zh : en;
  const own = OWN[language];
  if (!own) return base;
  return { ...base, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) };
}
