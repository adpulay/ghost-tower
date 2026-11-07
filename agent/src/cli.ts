#!/usr/bin/env -S npx tsx
// Ghost Tower agent CLI.
//   tsx src/cli.ts run [--record replay/demo-01.json]   watch Spacetime and investigate tracks
//   tsx src/cli.ts replay <file> [--track-id N] [--speed 2]   write a recorded trace back
//   tsx src/cli.ts warm                                   one dummy request to warm Nemotron
//   tsx src/cli.ts local [scenario] [--realtime] [--record file]   offline run in memory

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmConfig, loadDotEnv, spacetimeConfig } from "./config.js";
import { createModel } from "./llm/index.js";
import { warmUp } from "./llm/nemotron.js";
import { loadRecording, RecordingWorld, replay } from "./replay.js";
import { runScenario } from "./runScenario.js";
import { SCENARIOS } from "./scenarios.js";
import { AgentService } from "./service.js";
import { SpacetimeHttpWorld } from "./world/spacetimeHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(here, "../.env"));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function toolLogger() {
  const dir = resolve(here, "../logs");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "tool_calls.jsonl");
  return (e: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
    appendFileSync(file, line + "\n");
    if (process.env.AGENT_VERBOSE === "1") console.log(line);
  };
}

async function main() {
  const [cmd = "run", ...args] = process.argv.slice(2);
  const model = createModel();

  if (cmd === "warm") {
    const ms = await warmUp(model);
    console.log(`warm: ${model.name} answered in ${ms} ms`);
    return;
  }

  if (cmd === "replay") {
    const file = args[0] ?? resolve(here, "../replay/demo-01.json");
    const rec = loadRecording(file);
    const world = new SpacetimeHttpWorld(spacetimeConfig());
    await world.ensureIdentity();
    const trackId = flag(args, "--track-id");
    const n = await replay(rec, world, { trackId: trackId ? Number(trackId) : undefined, speed: Number(flag(args, "--speed") ?? 1) });
    console.log(`replayed ${n} ops from ${file} (recorded with ${rec.model})`);
    return;
  }

  if (cmd === "local") {
    const id = args.find((a) => !a.startsWith("--") && SCENARIOS[a]) ?? "demo-01";
    const run = await runScenario(SCENARIOS[id], model, { realtime: args.includes("--realtime"), onTrace: (l) => console.log(l) });
    const out = flag(args, "--record");
    if (out) {
      run.recorder.save(out, id, model.name);
      console.log(`recorded ${run.recorder.ops.length} ops to ${out}`);
    }
    return;
  }

  if (cmd === "run") {
    const cfg = spacetimeConfig();
    const base = new SpacetimeHttpWorld(cfg);
    await base.ensureIdentity();
    const recordPath = flag(args, "--record");
    const world = recordPath ? new RecordingWorld(base) : base;
    const service = new AgentService(world, model, { log: toolLogger() });
    console.log(`agent: ${model.name} (${llmConfig().provider}), spacetime ${cfg.host}/${cfg.database}, polling every ${cfg.pollMs} ms`);
    service.start(cfg.pollMs);
    const shutdown = () => {
      service.stop();
      if (recordPath && world instanceof RecordingWorld) {
        world.save(recordPath, flag(args, "--scenario") ?? "demo-01", model.name);
        console.log(`\nrecorded ${world.ops.length} ops to ${recordPath}`);
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  console.error(`unknown command ${cmd}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
