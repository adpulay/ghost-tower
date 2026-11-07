import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentTraceRow, TrackHeaderRow } from "./types";
import "./trace-panel.css";

/** Marker the agent appends to tool results that came from a mocked tool (carrier lookup). */
export const SIMULATED_TAG = "[simulated]";

const KIND_META: Record<string, { label: string; icon: string }> = {
  plan: { label: "Plan", icon: "◆" },
  tool_call: { label: "Tool", icon: "→" },
  tool_result: { label: "Result", icon: "←" },
  replan: { label: "Re-plan", icon: "↻" },
  summary: { label: "Summary", icon: "✓" },
};

export interface TracePanelProps {
  /** Selected track (header). Pass the live `track` row; nothing is computed from it. */
  track: TrackHeaderRow | null | undefined;
  /** agent_trace rows for the selected track (any order; sorted here). */
  traces: AgentTraceRow[];
  className?: string;
  /** Hide tool_call rows to save space on small screens. */
  compact?: boolean;
}

export function splitSimulated(text: string): { text: string; simulated: boolean } {
  const t = text.trimEnd();
  return t.endsWith(SIMULATED_TAG) ? { text: t.slice(0, -SIMULATED_TAG.length).trimEnd(), simulated: true } : { text, simulated: false };
}

function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function TracePanel({ track, traces, className, compact }: TracePanelProps) {
  const rows = useMemo(
    () =>
      [...traces]
        .filter((t) => !track || t.track_id === track.id)
        .filter((t) => !(compact && t.kind === "tool_call"))
        .sort((a, b) => a.ts_ms - b.ts_ms || a.id - b.id),
    [traces, track, compact],
  );

  const listRef = useRef<HTMLOListElement>(null);
  const [stick, setStick] = useState(true);
  const [freshId, setFreshId] = useState<number | null>(null);
  const lastId = rows.at(-1)?.id ?? null;

  // Newest at the bottom; follow it unless the analyst scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [rows.length, lastId, stick]);

  useEffect(() => {
    if (lastId === null) return;
    setFreshId(lastId);
    const t = setTimeout(() => setFreshId(null), 1200);
    return () => clearTimeout(t);
  }, [lastId]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const status = track?.status ?? "";
  return (
    <section className={`gt-trace ${className ?? ""}`} aria-label="Agent trace">
      <header className="gt-trace__header">
        <div className="gt-trace__title">
          <span className="gt-trace__brand">Nemotron agent</span>
          {track ? <span className="gt-trace__track">Track #{track.id}</span> : <span className="gt-trace__track gt-trace__muted">No track selected</span>}
        </div>
        {track && (
          <div className="gt-trace__meta">
            <span className={`gt-trace__status gt-trace__status--${status}`}>{status || "unknown"}</span>
            <span className="gt-trace__conf" title="Set by the database (recluster), not by the agent">
              confidence <strong>{Number.isFinite(track.confidence) ? track.confidence.toFixed(2) : "–"}</strong>
            </span>
          </div>
        )}
      </header>

      <ol className="gt-trace__list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {rows.length === 0 && <li className="gt-trace__empty">Waiting for the agent…</li>}
        {rows.map((r) => {
          const meta = KIND_META[r.kind] ?? { label: r.kind, icon: "·" };
          const { text, simulated } = splitSimulated(r.text);
          return (
            <li key={r.id} className={`gt-trace__row gt-trace__row--${r.kind}${r.id === freshId ? " gt-trace__row--fresh" : ""}`}>
              <span className="gt-trace__icon" aria-hidden>
                {meta.icon}
              </span>
              <span className="gt-trace__body">
                {r.kind === "replan" && <span className="gt-trace__badge">Re-plan</span>}
                <span className="gt-trace__text">{text}</span>
                {simulated && (
                  <span className="gt-trace__sim" title="This tool is mocked for the demo">
                    simulated
                  </span>
                )}
              </span>
              <time className="gt-trace__time" dateTime={new Date(r.ts_ms).toISOString()}>
                {clock(r.ts_ms)}
              </time>
            </li>
          );
        })}
      </ol>

      {!stick && (
        <button type="button" className="gt-trace__jump" onClick={() => setStick(true)}>
          ↓ Latest
        </button>
      )}
    </section>
  );
}
