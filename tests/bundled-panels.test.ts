import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { WebUiAssets } from 'cortico/web/webui-pages.ts';
import { bundledWebUiAssets } from '../core/bundled-panels.ts';

const log = { error: (msg: string) => { throw new Error(msg); } } as unknown as Logger;

describe('bundled World panels', () => {
  // needs the panel bundle that `pnpm run build:cortico` builds
  it('the WebUI server has a bundle for the desktop pet and social media pages and serves their files', () => {
    const table = bundledWebUiAssets([
      { id: 'desktop-pet', packageName: 'cortico-world-desktop-pet' },
      { id: 'social', packageName: 'cortico-world-social' },
    ]);
    expect(table.map((a) => a.pageId)).toEqual(['world:desktop-pet', 'world:social']);
    const assets = new WebUiAssets(join(tmpdir(), 'no-web-dist'), log, table);
    for (const [i, name] of ['desktop-pet', 'social'].entries()) {
      expect(existsSync(table[i].jsFile) && existsSync(table[i].cssFile!), name).toBe(true);
      // package version plus a content hash, so a rebuilt bundle gets a new URL
      expect(table[i].version).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{10}$/);
      expect(assets.forPage(`world:${name}`)).toEqual({
        js: expect.stringMatching(new RegExp(`^/assets/extensions/cortico-world-${name}/.+\\.js$`)),
        css: expect.stringMatching(/\.css$/),
      });
    }
  });
});
