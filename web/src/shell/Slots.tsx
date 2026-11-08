import { useMemo } from "react";
import { Link } from "react-router-dom";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection, SPACETIME_DB, SPACETIME_HOST } from "../module_bindings";
import PatrolView from "../patrol/PatrolView";
import { useTables } from "../spacetime/SpacetimeContext";

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
          <h1>Patrol view isn't available in the demo</h1>
          <p>
            The patrol view only works when Ghost Tower is connected to real phone reports. The overview is running on
            demo data right now, so there is nothing for an officer to follow.
          </p>
          <p className="muted">
            For setup: publish the module, then set <code>VITE_SPACETIME_URI</code> in <code>web/.env</code> or open this
            page with <code>?source=live</code>.
          </p>
          <p>
            <Link to="/">Back to the overview</Link>
          </p>
        </div>
      </div>
    );
  }
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      {/* Always on, like the analyst map's tag: the blaster and most phones are simulated. */}
      <span className="sim-corner" title="The fake tower and most phones in this demo are simulated">Simulated data</span>
      <PatrolView />
    </SpacetimeDBProvider>
  );
}
