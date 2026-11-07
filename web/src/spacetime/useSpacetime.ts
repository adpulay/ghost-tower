import { useEffect, useMemo, useState } from "react";
import { createLiveSource } from "./liveSource";
import { createMockSource } from "./mockSource";
import { emptyTables, type ConnectionStatus, type DataSource, type Tables } from "./types";

export interface SpacetimeState {
  tables: Tables;
  status: ConnectionStatus;
  detail: string;
  mode: "mock" | "live";
  debug: boolean;
}

/**
 * Shared client hook for the analyst map, the patrol view (Role 1) and the trace
 * panel (Role 2). Returns live table snapshots.
 *
 * Source selection (one config value to switch hosts):
 *   - `?source=mock` or `?source=live` in the URL wins
 *   - else VITE_SPACETIME_URI set -> live
 *   - else mock
 * `?debug=1` additionally exposes sim_truth. Without it, sim_truth is always emptied
 * here, so no component can render ground truth by accident.
 */
export function useSpacetime(): SpacetimeState {
  const params = new URLSearchParams(window.location.search);
  const debug = params.get("debug") === "1";
  const wanted = params.get("source");
  const uri = import.meta.env.VITE_SPACETIME_URI as string | undefined;
  const dbName = (import.meta.env.VITE_SPACETIME_DB as string | undefined) ?? "ghost-tower";
  const useLive = wanted === "live" || (wanted !== "mock" && !!uri);

  const source: DataSource = useMemo(
    () => (useLive ? createLiveSource(uri ?? "", dbName, debug) : createMockSource()),
    [useLive, uri, dbName, debug],
  );

  const [tables, setTables] = useState<Tables>(emptyTables);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    return source.start(
      (t) => setTables(debug ? t : { ...t, sim_truth: [] }),
      (s, d) => {
        setStatus(s);
        setDetail(d ?? "");
      },
    );
  }, [source, debug]);

  return { tables, status, detail, mode: source.mode, debug };
}
