// End-to-end smoke test for a published module. NOT the simulator (that's sim/, Role 1):
// it drives one fake blaster east then north through 300 seeded phones in real time, calls
// report_anomaly / sim_write_truth over the HTTP API, and prints the track table every 3 s so
// you can watch recluster work.
//
//   npx tsx scripts/smoke.ts --host http://127.0.0.1:3010 --db ghost-tower --seconds 150 --turn-at 90
//   npx tsx scripts/smoke.ts --host https://maincloud.spacetimedb.com --db ghost-tower-94144
//
// Uses the demo-only domain txtag-pay-demo.example (never a real phishing domain).

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const HOST = opt("host", process.env.SPACETIME_HOST ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const DB = opt("db", process.env.SPACETIME_DB ?? "ghost-tower");
const SECONDS = Number(opt("seconds", "150"));
const TURN_AT = Number(opt("turn-at", "90"));
const SEED = Number(opt("seed", "1"));

const URL_HASH = createHash("sha256").update("txtag-pay-demo.example").digest("hex");
const RANGE_M = 500;
const SPEED_MPS = 11;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rad = (d: number) => (d * Math.PI) / 180;
function dist(a: [number, number], b: [number, number]) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

let token = process.env.SPACETIME_TOKEN ?? "";
async function identity() {
  if (token) return;
  const r = await fetch(`${HOST}/v1/identity`, { method: "POST" });
  if (!r.ok) throw new Error(`identity: HTTP ${r.status}`);
  token = ((await r.json()) as { token: string }).token;
}
async function call(reducer: string, a: unknown[]) {
  const r = await fetch(`${HOST}/v1/database/${encodeURIComponent(DB)}/call/${reducer}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(a),
  });
  if (!r.ok) throw new Error(`${reducer}: HTTP ${r.status} ${await r.text()}`);
}
async function sql(q: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${HOST}/v1/database/${encodeURIComponent(DB)}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: q,
  });
  if (!r.ok) throw new Error(`sql: HTTP ${r.status} ${await r.text()}`);
  const [res] = (await r.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
  const names = res!.schema.elements.map((e) => e.name.some);
  return res!.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

async function main() {
  await identity();
  const r = rng(SEED);
  const phones: [number, number][] = [];
  for (let i = 0; i < 300; i++) phones.push([32.97 + r() * 0.03, -96.78 + r() * 0.05]);
  const lastHit = new Map<number, number>();
  let pos: [number, number] = [32.976, -96.775];
  const t0 = Date.now();
  console.log(`smoke → ${HOST} db=${DB} for ${SECONDS}s, turn north at ${TURN_AT}s`);

  for (let s = 0; s <= SECONDS; s++) {
    const tickStart = Date.now();
    const north = s >= TURN_AT;
    pos = north
      ? [pos[0] + SPEED_MPS / 111_320, pos[1]]
      : [pos[0], pos[1] + SPEED_MPS / (111_320 * Math.cos(rad(pos[0])))];
    const now = Date.now();
    const calls: Promise<void>[] = [call("sim_write_truth", ["smoke", now, pos[0], pos[1], true])];
    phones.forEach((p, i) => {
      if (dist(p, pos) > RANGE_M) return;
      if (now - (lastHit.get(i) ?? -Infinity) < 60_000) return;
      lastHit.set(i, now);
      const lat = p[0] + (r() - 0.5) * 0.002;
      const lon = p[1] + (r() - 0.5) * 0.002;
      calls.push(call("report_anomaly", [now, lat, lon, true, 5 + r() * 5, 0.97, URL_HASH, "TxTag", "no", "sim"]));
    });
    await Promise.all(calls);
    if (s % 3 === 0) {
      const tracks = await sql("SELECT * FROM track");
      const line = tracks
        .map((t) => {
          const err = dist([t.lat as number, t.lon as number], pos);
          return `#${t.id} ${t.status} conf=${(t.confidence as number).toFixed(2)} n=${t.event_count} hdg=${Math.round(t.heading_deg as number)}° v=${(t.speed_mps as number).toFixed(1)} err=${Math.round(err)}m`;
        })
        .join(" | ");
      console.log(`t=${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s truth hdg=${north ? 0 : 90}°  ${line || "(no tracks)"}`);
    }
    await new Promise((res) => setTimeout(res, Math.max(0, 1000 - (Date.now() - tickStart))));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
