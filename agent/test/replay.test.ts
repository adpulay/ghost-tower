import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import { loadRecording, replay } from "../src/replay.js";
import { runScenario } from "../src/runScenario.js";
import { SCENARIOS } from "../src/scenarios.js";
import { MemoryWorld } from "../src/world/memory.js";
import { decodeRows } from "../src/world/spacetimeHttp.js";

test("record → save → replay reproduces the same trace with original timing", async () => {
  const run = await runScenario(SCENARIOS["demo-01"], new MockPolicy());
  const file = join(mkdtempSync(join(tmpdir(), "gt-")), "rec.json");
  run.recorder.save(file, "demo-01", "mock:policy");
  const rec = loadRecording(file);

  let clock = 1_000;
  const waits: number[] = [];
  const target = new MemoryWorld(() => clock);
  const n = await replay(rec, target, {
    trackId: 42,
    speed: 1,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  assert.equal(n, rec.ops.length);
  assert.deepEqual(target.traces.map((t) => t.text), run.world.traces.map((t) => t.text));
  assert.ok(target.traces.every((t) => t.track_id === 42));
  assert.equal(target.alerts.length, run.world.alerts.length);
  const totalWait = waits.reduce((a, b) => a + b, 0);
  assert.equal(totalWait, rec.ops.at(-1)!.t_ms, "replay spans the original duration");
});

test("SATS SQL rows decode to named objects", () => {
  const rows = decodeRows<{ id: number; status: string }>({
    schema: { elements: [{ name: { some: "id" } }, { name: { some: "status" } }] },
    rows: [[1, "active"], ["18446744073709551", "dormant"]],
  });
  assert.deepEqual(rows[0], { id: 1, status: "active" });
  assert.equal(typeof rows[1].id, "number");
});
