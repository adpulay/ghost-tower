// Push relay: sends the agent's warnings to a phone through ntfy (https://ntfy.sh), a free push service.
//
// It watches the Spacetime `alert` table and posts each new warning to an ntfy topic, so the phone gets a real
// notification (even with the app closed) when the agent warns. It does not change the agent: it only reads alerts.
//
//   NTFY_TOPIC=<long-random-topic> npm run ntfy            # run it next to the agent
//   NTFY_TOPIC=<topic> npm run ntfy -- --test              # send one test notification and exit
//
// Settings (environment or the repo's .env):
//   NTFY_TOPIC               required. Anyone who knows the topic name can read and post to it: make it long and random.
//   NTFY_SERVER              default https://ntfy.sh
//   NTFY_PIN                 "lat,lon" of the demo phone; only alerts whose zone covers it are pushed (default: the
//                            Android app's demo spot). Set NTFY_PIN=off to push every alert.
//   NTFY_MIN_INTERVAL_S      at most one push per this many seconds (default 45; the agent sends two near-identical
//                            alerts per warning)
//   SPACETIME_HOST / SPACETIME_DB   as for the agent
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, spacetimeConfig } from "./config.js";

loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"));

const topic = process.env.NTFY_TOPIC?.trim();
if (!topic) {
  console.error("Set NTFY_TOPIC (the ntfy topic your phone is subscribed to).");
  process.exit(1);
}
const server = (process.env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/$/, "");
const minIntervalMs = Number(process.env.NTFY_MIN_INTERVAL_S ?? 45) * 1000;
const pinEnv = (process.env.NTFY_PIN ?? "32.98036,-96.76805").trim();
const pin: [number, number] | null = pinEnv === "off" ? null : (pinEnv.split(",").map(Number) as [number, number]);
const st = spacetimeConfig();

type LatLon = [number, number];
interface Alert { id: number; trackId: number; zone: LatLon[]; message: string; sentMs: number; recipients: number }

/** Ray casting; polygons are [lat, lon] lists. */
function contains(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function push(title: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic!)}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "warning" },
      body,
    });
    if (!res.ok) console.error(`ntfy: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    return res.ok;
  } catch (e) {
    console.error("ntfy: could not reach", server, (e as Error).message);
    return false;
  }
}

async function readAlerts(): Promise<Alert[] | null> {
  try {
    const res = await fetch(`${st.host}/v1/database/${st.database}/sql`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...(st.token ? { authorization: `Bearer ${st.token}` } : {}) },
      body: "SELECT * FROM alert",
    });
    if (!res.ok) return null;
    const out: Alert[] = [];
    for (const r of (await res.json()) as any[]) {
      const names: string[] = r.schema.elements.map((e: any) => (typeof e.name === "object" ? e.name?.some : e.name));
      for (const row of r.rows as any[][]) {
        const v = (n: string) => row[names.indexOf(n)];
        out.push({
          id: Number(v("id")), trackId: Number(v("track_id")), zone: JSON.parse(String(v("zone_json") ?? "[]")),
          message: String(v("message") ?? ""), sentMs: Number(v("sent_ms")), recipients: Number(v("recipients")),
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

if (process.argv.includes("--test")) {
  const ok = await push("Ghost Tower test", "If you can read this, push notifications from Ghost Tower work.");
  console.log(ok ? `sent a test notification to ${server}/${topic}` : "test notification failed");
  process.exit(ok ? 0 : 1);
}

console.log(`ntfy relay: ${st.host}/${st.database} -> ${server}/${topic}; pin ${pin ? pin.join(",") : "off (push every alert)"}`);

let lastId = -1; // highest alert id already looked at; -1 = not baselined yet
let sawAlerts = false;
let lastPushMs = 0;

for (;;) {
  const alerts = await readAlerts();
  if (alerts) {
    if (alerts.length === 0) {
      if (sawAlerts) console.log("alert table emptied (world reset); watching for new warnings");
      sawAlerts = false;
      if (lastId < 0) lastId = 0;
    } else if (lastId < 0) {
      // Alerts that already exist were sent before the relay was watching: don't push them.
      lastId = Math.max(...alerts.map((a) => a.id));
      sawAlerts = true;
    } else {
      sawAlerts = true;
      for (const a of alerts.filter((x) => x.id > lastId).sort((x, y) => x.id - y.id)) {
        lastId = a.id;
        if (pin && !contains(pin, a.zone)) {
          console.log(`alert ${a.id}: zone does not cover the demo phone, not pushed`);
          continue;
        }
        if (Date.now() - lastPushMs < minIntervalMs) {
          console.log(`alert ${a.id}: within ${minIntervalMs / 1000} s of the last push, skipped`);
          continue;
        }
        const ok = await push("Fake tower heading your way", a.message);
        if (ok) lastPushMs = Date.now();
        console.log(`alert ${a.id}: ${ok ? "pushed" : "push FAILED"} (${a.recipients} phones warned): ${a.message}`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, st.pollMs));
}
