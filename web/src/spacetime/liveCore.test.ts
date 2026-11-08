import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveSourceWith, plain, type ConnectHandlers, type LiveConn, type TableHandle } from "./liveCore.ts";
import type { ConnectionStatus, Tables } from "./types.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Spacetime connection: rows in arrays, callbacks fired by the test. */
function fakeWorld(initial: Record<string, Record<string, unknown>[]> = {}) {
  const rows: Record<string, Record<string, unknown>[]> = { ...initial };
  const insertCbs: Record<string, (() => void)[]> = {};
  const subscribed: string[][] = [];
  let applied: (() => void) | undefined;
  let failed: ((ctx: unknown) => void) | undefined;
  let handlers!: ConnectHandlers;
  let disconnects = 0;

  const db: Record<string, TableHandle> = new Proxy({}, {
    get: (_t, name: string) => ({
      iter: () => rows[name] ?? [],
      onInsert: (cb: () => void) => void (insertCbs[name] = [...(insertCbs[name] ?? []), cb]),
      onDelete: () => {},
      onUpdate: () => {},
    }),
  });
  const conn: LiveConn = {
    db,
    subscriptionBuilder() {
      const b = {
        onApplied: (cb: () => void) => ((applied = cb), b),
        onError: (cb: (c: unknown) => void) => ((failed = cb), b),
        subscribe: (q: string[]) => void subscribed.push(q),
      };
      return b;
    },
  };
  return {
    rows, subscribed,
    connect: (h: ConnectHandlers) => {
      handlers = h;
      return { disconnect: () => void disconnects++ };
    },
    connected: () => handlers.onConnect(conn),
    apply: () => applied?.(),
    failSub: () => failed?.({}),
    connectError: (m: string) => handlers.onError(new Error(m)),
    dropped: (m?: string) => handlers.onDisconnect(m ? new Error(m) : undefined),
    insert: (table: string) => (insertCbs[table] ?? []).forEach((cb) => cb()),
    get disconnects() { return disconnects; },
  };
}

function run(world: ReturnType<typeof fakeWorld>, debug = false) {
  const snaps: Tables[] = [];
  const statuses: [ConnectionStatus, string | undefined][] = [];
  const stop = createLiveSourceWith(world.connect, debug).start(
    (t) => snaps.push(t),
    (s, d) => statuses.push([s, d]),
  );
  return { snaps, statuses, stop };
}

test("plain: u64 bigint becomes number, everything else is untouched", () => {
  const out = plain<{ id: number; ts_ms: number; lat: number; name: string; ok: boolean }>({
    id: 7n, ts_ms: 1762548000000n, lat: 32.986, name: "x", ok: true,
  });
  assert.deepEqual(out, { id: 7, ts_ms: 1762548000000, lat: 32.986, name: "x", ok: true });
});

test("nothing is emitted until the subscription is applied; then the status is connected", async () => {
  const w = fakeWorld({ track: [{ id: 1n, lat: 32.98, lon: -96.75, status: "active" }] });
  const { snaps, statuses, stop } = run(w);
  assert.deepEqual(statuses[0], ["connecting", undefined]);
  w.connected();
  await wait(150);
  assert.equal(snaps.length, 0);
  w.apply();
  assert.equal(statuses.at(-1)![0], "connected");
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].track, [{ id: 1, lat: 32.98, lon: -96.75, status: "active" }]);
  stop();
});

test("subscribes to the six public tables, and to sim_truth only in debug mode", () => {
  for (const debug of [false, true]) {
    const w = fakeWorld();
    const { stop } = run(w, debug);
    w.connected();
    const q = w.subscribed[0];
    assert.equal(q.length, debug ? 7 : 6);
    assert.equal(q.includes("SELECT * FROM sim_truth"), debug);
    assert.ok(q.includes("SELECT * FROM track") && q.includes("SELECT * FROM agent_trace"));
    stop();
  }
});

test("sim_truth never reaches the app without debug, even if the server sent rows", async () => {
  const w = fakeWorld({ sim_truth: [{ scenario: "demo-01#0", ts_ms: 1n, lat: 1, lon: 2, on_air: true }] });
  const off = run(w, false);
  w.connected(); w.apply();
  assert.deepEqual(off.snaps[0].sim_truth, []);
  off.stop();
  const on = run(w, true);
  w.connected(); w.apply();
  assert.equal(on.snaps[0].sim_truth.length, 1);
  on.stop();
});

test("a burst of row callbacks produces one snapshot", async () => {
  const w = fakeWorld({ anomaly_event: [] });
  const { snaps, stop } = run(w);
  w.connected(); w.apply();
  const before = snaps.length;
  for (let i = 0; i < 50; i++) {
    w.rows.anomaly_event.push({ id: BigInt(i), ts_ms: BigInt(1000 + i) });
    w.insert("anomaly_event");
  }
  await wait(200);
  assert.equal(snaps.length, before + 1);
  assert.equal(snaps.at(-1)!.anomaly_event.length, 50);
  stop();
});

test("events and traces are sorted by time and capped to the newest rows", async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: BigInt(i), ts_ms: BigInt(2500 - i) })); // newest has smallest id
  const w = fakeWorld({ anomaly_event: many });
  const { snaps, stop } = run(w);
  w.connected(); w.apply();
  const ev = snaps[0].anomaly_event;
  assert.equal(ev.length, 2000);
  assert.ok(ev.every((e, i) => i === 0 || ev[i - 1].ts_ms <= e.ts_ms), "ascending by ts_ms");
  assert.equal(ev.at(-1)!.ts_ms, 2500, "kept the newest");
  stop();
});

test("stopping before the connection completes disconnects and later callbacks do nothing", async () => {
  const w = fakeWorld();
  const { snaps, statuses, stop } = run(w);
  stop();
  assert.equal(w.disconnects, 1);
  const n = statuses.length;
  w.connected(); w.apply();
  w.connectError("late");
  await wait(150);
  assert.equal(snaps.length, 0);
  assert.equal(statuses.length, n);
});

test("connect error, subscription failure and disconnect all surface as error status", () => {
  const a = fakeWorld(); const ra = run(a);
  a.connectError("ECONNREFUSED");
  assert.match(ra.statuses.at(-1)![1]!, /ECONNREFUSED/);
  assert.equal(ra.statuses.at(-1)![0], "error");

  const b = fakeWorld(); const rb = run(b);
  b.connected(); b.failSub();
  assert.equal(rb.statuses.at(-1)![0], "error");

  const c = fakeWorld(); const rc = run(c);
  c.connected(); c.apply(); c.dropped("socket closed");
  assert.equal(rc.statuses.at(-1)![0], "error");
  assert.match(rc.statuses.at(-1)![1]!, /socket closed/);
  [ra, rb, rc].forEach((r) => r.stop());
});
