import type { ConnectionStatus, DataSource, Tables } from "./types";

/**
 * Live Spacetime subscriptions. NOT WIRED YET: Role 1's schema/host lands ~4:30 PM.
 *
 * To wire it:
 *   1. Role 1 runs `spacetime generate --lang typescript --out-dir web/src/spacetime/module_bindings`.
 *   2. Build a DbConnection with `uri` and `dbName`, call
 *      subscribe(["SELECT * FROM anomaly_event", "... track", "... campaign",
 *                  "... agent_trace", "... prediction", "... alert"]).
 *      Do NOT subscribe to sim_truth unless `debug` is set.
 *   3. On every table insert/update/delete callback, rebuild a Tables snapshot
 *      from conn.db.<table>.iter() and call onTables(snapshot).
 *   4. Row types in ./types.ts already match INTERFACES.md §2, so snapshots drop in as-is.
 */
export function createLiveSource(
  uri: string,
  dbName: string,
  _debug: boolean,
): DataSource {
  return {
    mode: "live",
    start(_onTables: (t: Tables) => void, onStatus: (s: ConnectionStatus, d?: string) => void) {
      onStatus(
        "error",
        `Live source not wired yet (${uri} / ${dbName}). Add the generated bindings in liveSource.ts, or drop ?source=live to use simulated data.`,
      );
      return () => {};
    },
  };
}
