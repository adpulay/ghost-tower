#!/usr/bin/env node
// Ghost Tower simulator.
//
//   sim run demo-01                 live, real time, against $SPACETIME_HOST / $SPACETIME_DB
//   sim run --speed 4x demo-01      live, 4x faster (sim clock runs ahead of wall clock)
//   sim run --local demo-01         in-process module, as fast as possible, prints tracks
//   sim run --no-reset demo-01      don't call reset_world first
//   sim reset                       reset_world on the live instance
//   sim list                        list scenarios
//
// Env: SPACETIME_HOST (default ws://localhost:3000), SPACETIME_DB (default ghost-tower),
//      CLASSIFIER_URL (optional; the /score endpoint, otherwise cached scores are used),
//      SPACETIME_TOKEN (the database operator's token; falls back to the repo's .env. Live runs need it).
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { listScenarios, loadScenario } from './scenario.ts';
import { liveSink, localSink, type Sink } from './sinks.ts';
import { classifierScores, SimWorld, type Scores } from './world.ts';

const USAGE = `usage:
  sim run [--speed 4x] [--local] [--no-reset] [--host ws://...] [--db name] <scenario>
  sim reset [--host ws://...] [--db name]
  sim list`;

/** Only the token comes from .env: the host and database must stay explicit, so a run can't hit Maincloud by surprise. */
function loadTokenFromDotEnv() {
  const file = new URL('../../.env', import.meta.url);
  if (process.env.SPACETIME_TOKEN || !existsSync(file)) return;
  const m = readFileSync(file, 'utf8').match(/^SPACETIME_TOKEN=(\S+)/m);
  if (m) process.env.SPACETIME_TOKEN = m[1];
}

async function main() {
  loadTokenFromDotEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      speed: { type: 'string', default: '1x' },
      local: { type: 'boolean', default: false },
      'no-reset': { type: 'boolean', default: false },
      host: { type: 'string' },
      db: { type: 'string' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, id] = positionals;
  if (values.help || !cmd) return console.log(USAGE);

  if (cmd === 'list') {
    for (const s of listScenarios()) {
      const sc = loadScenario(s);
      console.log(`${s.padEnd(12)} ${sc.kind.padEnd(7)} ${sc.description ?? ''}`);
    }
    return;
  }
  if (cmd === 'reset') {
    const sink = await liveSink({ host: values.host, db: values.db });
    await sink.reset();
    await sink.close();
    return console.log('reset_world done');
  }
  if (cmd !== 'run' || !id) return console.log(USAGE), process.exit(2);

  const speed = parseFloat(values.speed!.replace(/x$/i, ''));
  if (!(speed > 0)) throw new Error(`bad --speed ${values.speed}`);
  const scenario = loadScenario(id);

  let scores: Scores | undefined;
  if (process.env.CLASSIFIER_URL) {
    try {
      scores = await classifierScores(scenario, process.env.CLASSIFIER_URL);
      console.log(`classifier scores: lure ${scores.lure.map(r => r.join('-')).join(', ')}`);
    } catch (e) {
      console.warn(`classifier unavailable (${(e as Error).message}); using cached scores`);
    }
  }

  // Local runs use a fixed epoch (fully reproducible); live runs start at wall-clock now.
  const t0 = values.local ? undefined : Date.now();
  const world = new SimWorld(scenario, { t0Ms: t0, scores });
  const sink: Sink = values.local ? await localSink(world.t0Ms) : await liveSink({ host: values.host, db: values.db });
  if (!values['no-reset']) await sink.reset();

  console.log(
    `${scenario.id}: ${scenario.phones} phones, ${scenario.blasters.length} blaster(s), ` +
      `${world.durationS}s${values.local ? ' (local)' : ` at ${speed}x`}`,
  );
  const tickWallMs = scenario.tick_ms / speed;
  const wallStart = Date.now();
  let n = 0;
  let events = 0;
  for (const tick of world.ticks()) {
    await sink.tick(tick.tsMs, tick.truth, tick.events.map(e => e.args));
    events += tick.events.length;
    if (!values.quiet && Number.isInteger(tick.tS) && tick.tS % 30 === 0) {
      console.log(`t=${String(tick.tS).padStart(4)}s  events=${events}  ${summary(sink)}`);
    }
    if (!sink.local) {
      const wait = wallStart + ++n * tickWallMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
  console.log(`done: ${events} events. ${summary(sink)}`);
  await sink.close();
}

function summary(sink: Sink): string {
  if (!('world' in sink)) return '';
  const tracks = (sink as Awaited<ReturnType<typeof localSink>>).world.rows('track');
  const live = tracks.filter(t => t.status !== 'closed');
  return live.map(t => `#${t.id}:${t.status} conf=${t.confidence.toFixed(2)} n=${t.event_count}`).join('  ');
}

main().then(
  () => process.exit(0),
  e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
