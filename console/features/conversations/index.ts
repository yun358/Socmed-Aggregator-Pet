/**
 * 「对话记录」: the coopanion World's own `conversations` panel (saved conversations: the switch, how many
 * Coo may open, New conversation, and every saved one with Open and Delete), mounted on its own without the
 * World page around it, so the normal mode reaches it without the World tree.
 */
import type { Page, PageContext } from '../../base/page.ts';
import { intro } from '../intro.ts';
import { S } from './strings.ts';

const COOPANION_PAGE = 'world:coopanion';

async function mount(ctx: PageContext): Promise<void> {
  const { ui, root } = ctx;
  root.classList.add('home');
  root.append(intro(ui, S.nav));
  const box = ui.h('div');
  root.append(box);
  ctx.lifecycle.own(await ctx.mountPanel(COOPANION_PAGE, 'conversations', box));
}

export const conversationsPage: Page = {
  route: 'conversations',
  label: S.nav,
  icon: 'reply',
  mount,
};
