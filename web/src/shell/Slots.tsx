import { useMemo } from "react";
import { Link } from "react-router-dom";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection, SPACETIME_DB, SPACETIME_HOST } from "../module_bindings";
import PatrolView from "../patrol/PatrolView";
import { useTables } from "../spacetime/SpacetimeContext";
import { TracePanel } from "../trace-panel";
import { useFocusTrack } from "./IncidentPanel";

/**
 * Role 1's patrol tablet reads tables through `spacetimedb/react`, so it needs a real
 * connection under a SpacetimeDBProvider. That connection exists only on this route and
 * only when the app runs against a live host; the analyst map uses the shared hook.
 */
export function PatrolSlot() {
  const { mode } = useTables();
  const builder = useMemo(() => {
    const uri = (import.meta.env.VITE_SPACETIME_URI as string | undefined)?.replace(/^http/, "ws") || SPACETIME_HOST;
    const db = (import.meta.env.VITE_SPACETIME_DB as string | undefined) || SPACETIME_DB;
    return DbConnection.builder().withUri(uri).withDatabaseName(db);
  }, []);

  if (mode !== "live") {
    return (
      <div className="placeholder">
        <div className="placeholder-inner">
          <h2>Patrol tablet needs a live feed</h2>
          <p>
            It reads straight from a Spacetime host and does not run on the simulated feed. Publish the module, then
            set <code>VITE_SPACETIME_URI</code> in <code>web/.env</code> or open this page with{" "}
            <code>?source=live</code>.
          </p>
          <p>
            <Link to="/">Back to the analyst map</Link>
          </p>
        </div>
      </div>
    );
  }
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      {/* Always on, like the analyst map's tag: the blaster and most phones are simulated. */}
      <span className="flag flag-sim flag-corner">Simulated data</span>
      <PatrolView />
    </SpacetimeDBProvider>
  );
}

/** Role 2's trace panel, fed from the shared Spacetime hook for the live track. */
export function TracePanelSlot() {
  const { tables } = useTables();
  const track = useFocusTrack();
  const traces = track ? tables.agent_trace.filter((r) => r.track_id === track.id) : [];
  return (
    <section className="side-log" aria-label="Agent log">
      <header className="side-log-head">
        <h2>Agent log</h2>
        <span>Nemotron, newest at the bottom</span>
      </header>
      <TracePanel track={track} traces={traces} showHeader={false} />
    </section>
  );
}
