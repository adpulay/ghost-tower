import type { ComponentType } from "react";
import { useTables } from "../spacetime/SpacetimeContext";
import { TracePanel } from "../trace-panel";

/**
 * Role 1 drops the patrol tablet in at web/src/patrol/index.tsx (default export).
 * import.meta.glob resolves at build time and tolerates a missing file, so the
 * shell builds and runs before Role 1 has pushed.
 */
const patrolMods = import.meta.glob<{ default: ComponentType }>("../patrol/index.tsx", { eager: true });
const Patrol = Object.values(patrolMods)[0]?.default;

export function PatrolSlot() {
  if (Patrol) return <Patrol />;
  return (
    <div className="placeholder">
      <h2>Patrol view</h2>
      <p>Role 1 mounts the patrol tablet here: export a default component from <code>web/src/patrol/index.tsx</code>.</p>
    </div>
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
