import { twilioConfig, simPhonesConfig, type TwilioConfig, type SimPhonesConfig } from "../src/config.js";
import { corridorPolygon, isLatLonArray, pointInPolygon, seededRandom } from "../src/geo.js";
import type { LatLon } from "../src/types.js";
import type { ToolDef } from "./types.js";

export interface SendWarningDeps {
  twilio?: TwilioConfig;
  phones?: SimPhonesConfig;
  fetchImpl?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|co|us|info|biz|xyz|top|example)\b)/i;

/** Hard checks on public warning text (TESTING.md §2g): ≤160 chars, no URL. */
export function validateWarning(message: string): string | null {
  if (!message || !message.trim()) return "empty message";
  if (message.length > 160) return `message is ${message.length} chars (max 160)`;
  if (URL_RE.test(message)) return "message contains a link";
  return null;
}

const phoneCache = new Map<string, LatLon[]>();
export function simulatedPhones(cfg: SimPhonesConfig): LatLon[] {
  const key = `${cfg.seed}|${cfg.count}|${cfg.bbox.join(",")}`;
  let phones = phoneCache.get(key);
  if (!phones) {
    const rnd = seededRandom(`phones:${cfg.seed}`);
    const [minLat, minLon, maxLat, maxLon] = cfg.bbox;
    phones = Array.from({ length: cfg.count }, () => [minLat + rnd() * (maxLat - minLat), minLon + rnd() * (maxLon - minLon)] as LatLon);
    phoneCache.set(key, phones);
  }
  return phones;
}

let lastRealSendMs = 0;
/** Testing hook. */
export function _resetSendThrottle() {
  lastRealSendMs = 0;
}

/**
 * INTERFACES.md §7 send_warning(zone_polygon, message) -> { sent }.
 * Real Twilio texts go ONLY to the verified team phones (TWILIO_VERIFIED_NUMBERS), throttled to
 * one burst per TWILIO_MIN_INTERVAL_S so replans don't spam the team. `sent` = real deliveries
 * accepted by Twilio + simulated phones inside the zone.
 */
export async function sendWarning(input: { zone_polygon: LatLon[]; message: string }, deps: SendWarningDeps = {}): Promise<{ sent: number }> {
  const problem = validateWarning(input.message);
  if (problem) throw new Error(`send_warning refused: ${problem}`);
  if (!isLatLonArray(input.zone_polygon)) throw new Error("send_warning refused: zone_polygon must be [[lat,lon],...] with ≥3 points");

  const phones = simulatedPhones(deps.phones ?? simPhonesConfig());
  const simulated = phones.filter((p) => pointInPolygon(p, input.zone_polygon)).length;

  const tw = deps.twilio ?? twilioConfig();
  const now = (deps.now ?? Date.now)();
  const minInterval = Number(process.env.TWILIO_MIN_INTERVAL_S ?? 60) * 1000;
  let real = 0;
  if (tw.dryRun) {
    deps.log?.({ tool: "send_warning", mode: "dry-run", to: tw.verifiedNumbers.length, message: input.message });
  } else if (now - lastRealSendMs < minInterval) {
    deps.log?.({ tool: "send_warning", mode: "throttled", message: input.message });
  } else {
    lastRealSendMs = now;
    const f = deps.fetchImpl ?? fetch;
    const auth = Buffer.from(`${tw.accountSid}:${tw.authToken}`).toString("base64");
    const results = await Promise.allSettled(
      tw.verifiedNumbers.map(async (to) => {
        const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: to, From: tw.from, Body: input.message }).toString(),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`twilio ${res.status}`);
      }),
    );
    real = results.filter((r) => r.status === "fulfilled").length;
    deps.log?.({ tool: "send_warning", mode: "twilio", attempted: tw.verifiedNumbers.length, delivered: real });
  }
  return { sent: real + simulated };
}

export const sendWarningTool: ToolDef<{ zone_polygon?: LatLon[]; message?: string }, { sent: number }> = {
  name: "send_warning",
  description:
    "Text a warning to phones inside the zone. Omit zone_polygon to use a 300 m corridor around the latest predicted route. Omit message to use the latest draft_report warning.",
  parameters: {
    type: "object",
    properties: {
      zone_polygon: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[lat,lon],...]" },
      message: { type: "string", description: "Warning text from draft_report(kind='warning')" },
    },
  },
  async run(input, ctx) {
    let zone = isLatLonArray(input.zone_polygon) ? input.zone_polygon : undefined;
    if (!zone) {
      if (!ctx.memory.lastPrediction) throw new Error("no zone_polygon given and no predicted route yet; call predict_route first");
      zone = corridorPolygon(ctx.memory.lastPrediction.path, 300);
    }
    const message = input.message || (ctx.memory.lastDraft?.kind === "warning" ? ctx.memory.lastDraft.text : "");
    if (!message) throw new Error("no message given; call draft_report with kind='warning' first");
    const out = await sendWarning({ zone_polygon: zone, message }, { log: ctx.log, now: ctx.now });
    ctx.memory.lastZone = zone;
    ctx.memory.lastWarning = { message, sent: out.sent, zone };
    return out;
  },
  summarize(out) {
    return `Warning sent to ${out.sent} phones in the predicted path.`;
  },
};
