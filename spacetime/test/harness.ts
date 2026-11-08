// In-process SpacetimeDB world: the real module running on the SDK's wasm test datastore.
// Used by the module tests, `sim run --local` and the eval. Import ./sys_stub.ts first
// (the npm scripts pass it via --import; LocalWorld callers import it explicitly).
import { restoreConsole } from './sys_stub.ts';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import { Timestamp } from 'spacetimedb';
import * as mod from '../src/index.ts';
import { reclusterPass } from '../src/logic.ts';

restoreConsole();

type Mod = typeof mod;
type ReducerName = Exclude<keyof Mod, 'default' | 'init' | 'recluster'>;
type ArgsOf<K extends ReducerName> = Mod[K] extends (ctx: any, args: infer A) => any ? A : never;

export class LocalWorld {
  readonly clock: TestClock;
  readonly h;
  readonly #auth = TestAuth.internal();

  constructor(startMs = 0) {
    this.clock = new TestClock(new Timestamp(BigInt(startMs) * 1000n));
    this.h = createModuleTestHarness(mod.default, mod, { clock: this.clock });
    this.h.withReducerTx(this.#auth, ctx => mod.init(ctx, {}));
  }

  get db() {
    return this.h.db;
  }

  setNow(ms: number) {
    this.clock.set(new Timestamp(BigInt(Math.round(ms)) * 1000n));
  }

  /** Call a reducer in its own transaction, like a client would. Throws on SenderError. */
  call<K extends ReducerName>(name: K, args: ArgsOf<K>): void {
    const fn = mod[name] as unknown as (ctx: unknown, a: unknown) => void;
    this.h.withReducerTx(this.#auth, ctx => fn(ctx, args));
  }

  /** What the scheduled reducer does every 3 s on a server. */
  recluster(): { events: number; tracks: number } {
    return this.h.withReducerTx(this.#auth, ctx => reclusterPass(ctx));
  }

  rows<T extends keyof LocalWorld['db']>(table: T) {
    return [...(this.db[table] as unknown as { iter(): Iterable<any> }).iter()];
  }
}
