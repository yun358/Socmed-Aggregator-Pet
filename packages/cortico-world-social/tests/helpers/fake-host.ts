/**
 * A `WorldHost` for World tests. It records each event the World pushes with the options it was
 * pushed with, and the warnings the World logs; `accepts` says which MIME types the model takes.
 * The other host calls do nothing.
 */
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  /** The options each event in `events` was pushed with, in the same order. */
  pushOpts: Array<PushOptions | undefined> = [];
  warnings: string[] = [];
  accepts: (mime: string) => boolean = () => false;

  store = {
    get: (cursor: number) => this.events.find((e) => e.cursor === cursor),
    latestCursor: () => this.events.length,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];

  modelFacts = { model: () => 'fixture-model', accepts: (mime: string) => this.accepts(mime), contextWindow: () => 128000 };

  log = (() => {
    const warnings = this.warnings;
    const log = {
      child: () => log,
      info() {},
      warn: (message: string) => { warnings.push(message); },
      error() {},
      debug() {},
      trace() {},
      emit() {},
    };
    return log as unknown as WorldHost['log'];
  })();

  async pushEvent(e: Parameters<WorldHost['pushEvent']>[0], opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, origin: e.origin ?? 'external', cursor: this.events.length + 1, contextDelivery: opts?.deliver === false ? 'archive-only' : 'deliver' } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }

  pushDeferred(): void {}
  async drainPendingEvents(): Promise<EventEnvelope[]> { return []; }
  blob(): null { return null; }
  reportUsage(): void {}
}
