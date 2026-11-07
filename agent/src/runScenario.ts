import type { RunResult } from "./agent.js";
import type { ChatModel } from "./llm/types.js";
import { RecordingWorld } from "./replay.js";
import { ScenarioDriver, type Scenario } from "./scenarios.js";
import { AgentService } from "./service.js";
import { MemoryWorld } from "./world/memory.js";

export interface ScenarioRun {
  scenario: Scenario;
  world: MemoryWorld;
  recorder: RecordingWorld;
  runs: (RunResult & { startedAtS: number; endedAtS: number })[];
  startMs: number;
  /** Seconds-from-start clock used for every timestamp in this run. */
  clockS: () => number;
  toolLog: Record<string, unknown>[];
}

/**
 * Drive a scripted scenario through the real AgentService against an in-memory world.
 *
 * realtime=false (evals): virtual seconds advance as fast as the model allows; the clock is
 * virtual time + real time spent inside model/tool calls, so model latency still counts in
 * "time to first prediction".
 * realtime=true (recording a demo): one scenario second per wall-clock second.
 */
export async function runScenario(
  scenario: Scenario,
  model: ChatModel,
  opts: { realtime?: boolean; onTrace?: (line: string) => void; seed?: string } = {},
): Promise<ScenarioRun> {
  const startMs = Date.UTC(2026, 10, 8, 16, 0, 0);
  let virtualS = 0;
  let realExtraMs = 0;
  const wallStart = Date.now();
  const nowMs = opts.realtime ? () => startMs + (Date.now() - wallStart) : () => startMs + virtualS * 1000 + realExtraMs;
  const clockS = () => (nowMs() - startMs) / 1000;

  const world = new MemoryWorld(nowMs);
  const recorder = new RecordingWorld(world, nowMs);
  const toolLog: Record<string, unknown>[] = [];
  const runs: ScenarioRun["runs"] = [];
  const runStarts = new Map<string, number>();

  const service = new AgentService(recorder, model, {
    now: nowMs,
    log: (e) => {
      toolLog.push({ ...e, t_s: clockS() });
      if (e.event === "launch") runStarts.set(`${e.track}:${e.mode}`, clockS());
    },
    onRun: (r) => runs.push({ ...r, startedAtS: runStarts.get(`${r.trackId}:${r.mode}`) ?? 0, endedAtS: clockS() }),
  });
  const driver = new ScenarioDriver(scenario, world, startMs, opts.seed ?? scenario.id);

  let printed = 0;
  const flush = () => {
    if (!opts.onTrace) return;
    for (; printed < world.traces.length; printed++) {
      const t = world.traces[printed];
      opts.onTrace(`[${((t.ts_ms - startMs) / 1000).toFixed(1).padStart(6)}s] #${t.track_id} ${t.kind.padEnd(11)} ${t.text}`);
    }
  };

  for (let s = 0; s <= scenario.durationS; s++) {
    if (opts.realtime) {
      const target = wallStart + s * 1000;
      const wait = target - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    } else {
      virtualS = s;
    }
    driver.step(s);
    await service.tick();
    if (!opts.realtime) {
      const t0 = Date.now();
      await service.idle();
      realExtraMs += Date.now() - t0;
    }
    flush();
  }
  await service.idle();
  flush();
  return { scenario, world, recorder, runs, startMs, clockS, toolLog };
}
