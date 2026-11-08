import { useEffect, useMemo, useState } from "react";
import { compass } from "../patrol/patrolModel";
import { focusCampaign, focusTrack } from "../spacetime/focusTrack";
import { parseLatLonList, pointInPolygon } from "../spacetime/geo";
import type { Tables } from "../spacetime/types";
import { useTables } from "../spacetime/SpacetimeContext";
import { shieldSvg } from "./symbols";

const EVENT_WINDOW_MS = 120_000; // matches the recluster window

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The track the console follows: the active one (then most confident), not the newest. With live
 * data, benign noise keeps creating low-confidence candidates. See spacetime/focusTrack.ts.
 */
export function useFocusTrack() {
  const { tables } = useTables();
  return focusTrack(tables.track);
}

/** "in about 3 minutes", "in 40 seconds", "now". */
export function plainEta(s: number): string {
  if (s <= 5) return "now";
  if (s < 60) return `in ${Math.round(s / 5) * 5} seconds`;
  const m = Math.round(s / 60);
  return m === 1 ? "in about a minute" : `in about ${m} minutes`;
}

function sureness(conf: number): { label: string; level: number } {
  if (conf >= 0.8) return { label: "Very sure", level: 3 };
  if (conf >= 0.5) return { label: "Fairly sure", level: 2 };
  return { label: "Not sure yet", level: 1 };
}

type Tone = "safe" | "caution" | "danger" | "quiet";

export function IncidentPanel() {
  const { tables } = useTables();
  const now = useNow();
  const track = useFocusTrack();

  const reports = tables.anomaly_event.filter((e) => now - e.ts_ms <= EVENT_WINDOW_MS).length;
  const warned = tables.alert.reduce((s, a) => s + a.recipients, 0);
  const campaign = focusCampaign(track, tables.campaign);
  const prediction = track ? tables.prediction.find((p) => p.track_id === track.id) : undefined;
  const eta = prediction ? Math.max(0, Math.round(prediction.eta_s - (now - prediction.updated_ms) / 1000)) : undefined;

  let tone: Tone = "safe";
  let title = "No fake towers nearby";
  let body =
    "Ghost Tower is watching for phones that suddenly drop to 2G and then get a scam text. If that starts happening, it will show up here.";

  if (track?.status === "active") {
    tone = "danger";
    title = "Fake cell tower detected";
    const what = campaign ? `fake ${campaign.brand} texts` : "scam texts";
    const where = track.speed_mps >= 1
      ? `from a vehicle heading ${compass(track.heading_deg)} at about ${Math.round(track.speed_mps * 2.237)} mph`
      : "from a device that is not moving";
    body = `Someone is sending ${what} ${where}. Phones in its path are being warned.`;
  } else if (track?.status === "candidate") {
    tone = "caution";
    title = "Checking a possible fake tower";
    body = "A few phones got a scam text right after losing signal. Ghost Tower is waiting for more reports before warning anyone.";
  } else if (track) {
    tone = "quiet";
    title = "The fake tower went quiet";
    body = "No new reports for a while. Ghost Tower keeps watching in case it comes back.";
  }

  const sure = track ? sureness(track.confidence) : undefined;
  const hitAfter = useMemo(() => countHitAfterWarning(tables), [tables]);

  return (
    <section className={`status status-${tone}`} aria-labelledby="status-title">
      <div className="status-hero">
        <span className="status-shield" dangerouslySetInnerHTML={{ __html: shieldSvg(tone, 52) }} />
        <div>
          {tone === "danger" && <span className="tag tag-danger">Scam likely</span>}
          <h1 id="status-title" className="status-title">{title}</h1>
        </div>
      </div>
      <p className="status-body">{body}</p>

      {(warned > 0 || tone === "danger") && (
        <div className="protect">
          <p className="protect-main">
            <b>{warned.toLocaleString()}</b>
            <span>{warned === 1 ? "phone warned" : "phones warned"} before the tower reached them</span>
          </p>
          <p className={`protect-sub${hitAfter > 0 ? " bad" : ""}`}>
            {hitAfter === 0
              ? "Nobody has received the scam text after being warned."
              : `${hitAfter} ${hitAfter === 1 ? "phone" : "phones"} still got the scam text after the warning.`}
          </p>
        </div>
      )}

      <dl className="facts">
        {sure && (
          <div>
            <dt>How sure we are</dt>
            <dd>
              <span className="meter" aria-hidden>
                {[1, 2, 3].map((n) => <i key={n} className={n <= sure.level ? "on" : ""} />)}
              </span>
              {sure.label}
            </dd>
          </div>
        )}
        <div>
          <dt>Scam texts reported</dt>
          <dd>{reports} in the last 2 minutes</dd>
        </div>
        {campaign && (
          <div>
            <dt>Scam website</dt>
            <dd>
              Created {campaign.domain_age_days === 1 ? "yesterday" : `${campaign.domain_age_days} days ago`}
              <small>Brand-new websites are a common sign of a scam.</small>
            </dd>
          </div>
        )}
        {track?.status === "active" && eta !== undefined && (
          <div>
            <dt>Police can meet it</dt>
            <dd>
              {plainEta(eta)}
              <small>At the blue target on the map.</small>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

// There are no phone ids in the schema, so "got it after the warning" counts distinct reports that
// land inside an alert zone after that alert was sent.
function countHitAfterWarning(tables: Tables): number {
  const hit = new Set<number>();
  for (const a of tables.alert) {
    const zone = parseLatLonList(a.zone_json);
    if (zone.length < 3) continue;
    for (const e of tables.anomaly_event) {
      if (e.ts_ms > a.sent_ms && pointInPolygon([e.lat, e.lon], zone)) hit.add(e.id);
    }
  }
  return hit.size;
}
