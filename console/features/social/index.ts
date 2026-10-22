/**
 * 「社交媒体」: the social World's own `social` panel (the limits of one request, the platforms and
 * their logins, the daily autoscroll, the lifetime counter), mounted on its own without the World
 * page around it, so the normal mode reaches it without the World tree.
 */
import type { Page, PageContext } from '../../base/page.ts';
import { intro } from '../intro.ts';
import { S } from './strings.ts';

const SOCIAL_PAGE = 'world:social';

async function mount(ctx: PageContext): Promise<void> {
  const { ui, root } = ctx;
  root.classList.add('home');
  root.append(intro(ui, S.nav));
  const box = ui.h('div');
  root.append(box);
  ctx.lifecycle.own(await ctx.mountPanel(SOCIAL_PAGE, 'social', box));
}

export const socialPage: Page = {
  route: 'social',
  label: S.nav,
  icon: 'eye',
  mount,
};
