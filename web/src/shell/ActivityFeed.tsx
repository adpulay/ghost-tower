import { useEffect, useRef, useState } from "react";
import { splitSimulated, TracePanel } from "../trace-panel";
import { useTables } from "../spacetime/SpacetimeContext";
import { useFocusTrack } from "./IncidentPanel";

// The everyday view shows only the agent's decisions. Tool calls and raw results sit behind
// "Show technical steps", which swaps in Role 2's full trace panel.
const PLAIN_KINDS: Record<string, string> = {
  plan: "Started",
  replan: "Changed course",
  summary: "Done",
};

function shortTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ActivityFeed() {
  const { tables } = useTables();
  const track = useFocusTrack();
  const [technical, setTechnical] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const traces = track ? tables.agent_trace.filter((r) => r.track_id === track.id) : [];
  const plain = traces
    .filter((r) => r.kind in PLAIN_KINDS)
    .sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id); // newest first: what just happened is on top

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [plain.length]);

  return (
    <section className="activity" aria-labelledby="activity-title">
      <header className="activity-head">
        <h2 id="activity-title">What Ghost Tower did</h2>
        <button type="button" className="link-btn" aria-pressed={technical} onClick={() => setTechnical((v) => !v)}>
          {technical ? "Hide technical steps" : "Show technical steps"}
        </button>
      </header>

      {technical ? (
        <div className="activity-tech">
          <TracePanel track={track} traces={traces} showHeader={false} />
        </div>
      ) : (
        <ol className="activity-list" ref={listRef}>
          {plain.length === 0 && (
            <li className="activity-empty">Nothing to do yet. Actions show up here as soon as a fake tower is found.</li>
          )}
          {plain.map((r) => {
            const { text, simulated } = splitSimulated(r.text);
            return (
              <li key={r.id} className={`activity-item activity-${r.kind}`}>
                <div className="activity-meta">
                  <span>{PLAIN_KINDS[r.kind]}</span>
                  <time dateTime={new Date(r.ts_ms).toISOString()}>{shortTime(r.ts_ms)}</time>
                </div>
                <p>
                  {text}
                  {simulated && <span className="muted"> (simulated)</span>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
