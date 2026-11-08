import { useEffect, useState } from "react";
import { compass, formatEta } from "../patrol/patrolModel";
import { focusCampaign, focusTrack } from "../spacetime/focusTrack";
import { useTables } from "../spacetime/SpacetimeContext";

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

export function IncidentPanel() {
  const { tables } = useTables();
  const now = useNow();
  const track = useFocusTrack();

  const reports = tables.anomaly_event.filter((e) => now - e.ts_ms <= EVENT_WINDOW_MS).length;
  const warned = tables.alert.reduce((s, a) => s + a.recipients, 0);

  if (!track) {
    return (
      <section className="incident incident-empty" aria-label="Incident">
        <h2 className="incident-id">No track</h2>
        <p>Watching for 2G drops followed by a scam text. A track opens once reports cluster.</p>
        <dl className="facts" style={{ marginTop: 16 }}>
          <dt>Reports, last 2 min</dt>
          <dd>{reports}</dd>
        </dl>
      </section>
    );
  }

  // Only the campaign linked to this track; falling back to the newest campaign would show the wrong brand.
  const campaign = focusCampaign(track, tables.campaign);
  const prediction = tables.prediction.find((p) => p.track_id === track.id);
  const eta = prediction ? Math.max(0, Math.round(prediction.eta_s - (now - prediction.updated_ms) / 1000)) : undefined;
  const kmh = Math.round(track.speed_mps * 3.6);

  return (
    <section className="incident" aria-label="Incident">
      <div className="incident-head">
        <h2 className="incident-id">
          <span>Track </span>
          {track.id}
        </h2>
        <span className={`status-tag status-tag-${track.status}`}>{track.status}</span>
      </div>
      <p className="incident-sub">
        {campaign ? `Sending fake ${campaign.brand} texts` : "Lure not identified yet"}
        {track.speed_mps >= 1 ? `, moving ${compass(track.heading_deg)}` : ", stationary"}
      </p>

      <div className="readout">
        <div className="eta">
          <b>{eta === undefined ? "No fix" : formatEta(eta)}</b>
          <span>to intercept point</span>
        </div>
        <div>
          <b>{warned}</b>
          <span>phones warned</span>
        </div>
      </div>

      <dl className="facts">
        <dt>Position</dt>
        <dd className="data">
          {track.lat.toFixed(4)}, {track.lon.toFixed(4)}
        </dd>
        <dt>Speed</dt>
        <dd>{track.speed_mps >= 1 ? `${kmh} km/h` : "Stationary"}</dd>
        <dt>Confidence</dt>
        <dd>{Math.round(track.confidence * 100)}%</dd>
        <dt>Reports, last 2 min</dt>
        <dd>{reports}</dd>
        {campaign && (
          <>
            <dt>Lure domain age</dt>
            <dd>{campaign.domain_age_days === 1 ? "1 day" : `${campaign.domain_age_days} days`}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
