import type { ComponentType } from "react";
import { useTables } from "../spacetime/SpacetimeContext";

/**
 * Role 1 and Role 2 drop their components in at these paths (default exports).
 * import.meta.glob resolves at build time and tolerates a missing file, so the
 * shell builds and runs before either role has pushed.
 */
const patrolMods = import.meta.glob<{ default: ComponentType }>("../patrol/index.tsx", { eager: true });
const traceMods = import.meta.glob<{ default: ComponentType }>("../trace-panel/index.tsx", { eager: true });

const Patrol = Object.values(patrolMods)[0]?.default;
const Trace = Object.values(traceMods)[0]?.default;

export function PatrolSlot() {
  if (Patrol) return <Patrol />;
  return (
    <div className="placeholder">
      <h2>Patrol view</h2>
      <p>Role 1 mounts the patrol tablet here: export a default component from <code>web/src/patrol/index.tsx</code>.</p>
    </div>
  );
}

/** Fallback shown until Role 2's trace panel exists: a plain list of agent_trace rows. */
function FallbackTrace() {
  const { tables } = useTables();
  const rows = tables.agent_trace.slice(-12).reverse();
  return (
    <div className="fallback-trace">
      {rows.length === 0 && <p className="muted">Waiting for the agent…</p>}
      {rows.map((r) => (
        <div key={r.id} className={`trace-row kind-${r.kind}`}>
          <span className="trace-kind">{r.kind}</span> {r.text}
        </div>
      ))}
    </div>
  );
}

export function TracePanelSlot() {
  return (
    <section className="side-panel">
      <h2>Agent trace</h2>
      {Trace ? <Trace /> : <FallbackTrace />}
    </section>
  );
}
