import { useMemo } from "react";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection, SPACETIME_DB, SPACETIME_HOST } from "../module_bindings";
import PatrolView from "../patrol/PatrolView";
import { useTables } from "../spacetime/SpacetimeContext";
import { TracePanel } from "../trace-panel";

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
        <h2>Patrol view</h2>
        <p>
          The patrol tablet reads from a live Spacetime host. Set <code>VITE_SPACETIME_URI</code> in{" "}
          <code>web/.env</code> (or open with <code>?source=live</code>) and publish the module; it does not run on
          the simulated feed.
        </p>
      </div>
    );
  }
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      <PatrolView />
    </SpacetimeDBProvider>
  );
}

/** Role 2's trace panel, fed from the shared Spacetime hook for the live track. */
export function TracePanelSlot() {
  const { tables } = useTables();
  const live = tables.track.filter((t) => t.status === "active" || t.status === "candidate");
  const track = live[live.length - 1] ?? tables.track[tables.track.length - 1];
  const traces = track ? tables.agent_trace.filter((r) => r.track_id === track.id) : [];
  return (
    <section className="side-panel">
      <h2>Agent trace</h2>
      <TracePanel track={track} traces={traces} />
    </section>
  );
}
