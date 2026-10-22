/** Package entry: the default export is the `WorldDefinition`. */
import { SOCIAL } from './definition.ts';

export default SOCIAL;

export { SOCIAL };
export { socialDefinition, type SocialAssembly } from './definition.ts';
export { SOCIAL_DEFAULTS, SOCIAL_ID, socialConfigGroup, type AutoscrollJob, type ImageMode, type SocialConfigSection } from './config.ts';
export { SOCIAL_TOOL_DECLS } from './tools.ts';
export { SocialWorld, type SocialPanelState } from './world.ts';
export { socialText, type SocialText } from './i18n/index.ts';
export type { ModelLanguage } from './model-text.ts';
