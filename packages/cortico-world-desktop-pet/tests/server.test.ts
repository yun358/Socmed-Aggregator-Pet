import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PetServer } from '../src/server.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const servers: PetServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); });

async function serve(overlay: { on: boolean }) {
  const server = new PetServer({
    port: () => 0, webDir: WEB_DIR, snapshot: () => ({}),
    onPetMessage: () => {}, onAudio: () => {}, onPetConnect: () => {}, onPetDisconnect: () => {}, onSkin: () => {}, onPrefs: () => {},
    overlay: () => overlay.on,
  });
  servers.push(server);
  await server.start();
  return server;
}

/** A socket to `role`, with the text messages and binary frames it got, and its close code. */
async function socket(server: PetServer, role: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/socket?role=${role}`);
  const texts: Array<Record<string, unknown>> = [];
  const frames: Buffer[] = [];
  let closed: number | null = null;
  ws.on('message', (data, isBinary) => { if (isBinary) frames.push(data as Buffer); else texts.push(JSON.parse(String(data))); });
  ws.on('close', (code) => { closed = code; });
  await new Promise((r) => ws.once('open', r));
  return { ws, texts, frames, closed: () => closed };
}

describe('OBS overlay', () => {
  it('is not served while off', async () => {
    const server = await serve({ on: false });
    expect((await fetch(`${server.origin}/overlay`)).status).toBe(404);
    const viewer = await socket(server, 'overlay');
    await expect.poll(viewer.closed).toBe(4003);
  });

  it('streams while a page watches: the window process is told, and its frames reach the page as sent', async () => {
    const state = { on: true };
    const server = await serve(state);
    const page = await fetch(`${server.origin}/overlay`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/web/overlay.js');

    const source = await socket(server, 'overlay-source');
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: false });
    const viewer = await socket(server, 'overlay');
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: true });

    const frame = Buffer.from([1, 2, 3, 4, 5]);
    source.ws.send(frame);
    await expect.poll(() => viewer.frames.length).toBe(1);
    expect(viewer.frames[0]).toEqual(frame);

    viewer.ws.close();
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: false });
  });

  it('the pages are sent a clearing frame when the window process goes', async () => {
    const server = await serve({ on: true });
    const source = await socket(server, 'overlay-source');
    const viewer = await socket(server, 'overlay');
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: true });
    source.ws.close();
    await expect.poll(() => viewer.frames.length).toBe(1);
    // a header of zeros: no display size and an empty part
    expect([...new Uint32Array(new Uint8Array(viewer.frames[0]!).buffer)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('turning it off closes the pages watching and stops the stream', async () => {
    const state = { on: true };
    const server = await serve(state);
    const source = await socket(server, 'overlay-source');
    const viewer = await socket(server, 'overlay');
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: true });
    state.on = false;
    server.syncOverlay();
    await expect.poll(viewer.closed).toBe(4003);
    await expect.poll(() => source.texts.at(-1)).toEqual({ t: 'overlay', on: false });
  });
});
