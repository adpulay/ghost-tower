// Live Spacetime source, written against a minimal connection interface so it can be
// unit-tested with a fake (no server). liveSource.ts plugs in Role 1's real DbConnection.
// Imports use .ts extensions and `import type` only so Node can run the tests directly.
import type { ConnectionStatus, DataSource, Tables } from "./types.ts";

export interface TableHandle {
  iter(): Iterable<Record<string, unknown>>;
  onInsert(cb: (...args: never[]) => void): void;
  onDelete(cb: (...args: never[]) => void): void;
  onUpdate(cb: (...args: never[]) => void): void;
}

export interface SubscriptionBuilderLike {
  onApplied(cb: () => void): SubscriptionBuilderLike;
  onError(cb: (ctx: unknown) => void): SubscriptionBuilderLike;
  subscribe(queries: string[]): unknown;
}

export interface LiveConn {
  db: Record<string, TableHandle>;
  subscriptionBuilder(): SubscriptionBuilderLike;
}

export interface ConnectHandlers {
  onConnect(conn: LiveConn): void;
  onError(err: Error): void;
  onDisconnect(err?: Error): void;
}

/** Starts connecting; returns a handle that can be disconnected at any time, even before onConnect. */
export type ConnectFn = (h: ConnectHandlers) => { disconnect(): void };

/** Tables mirrored into the app. sim_truth is added only in debug mode. */
const TABLES = ["anomaly_event", "track", "campaign", "agent_trace", "prediction", "alert"] as const;

/** Bounds so a long run can't grow the React state without limit. The map shows 120 s anyway. */
const CAPS = { anomaly_event: 2000, agent_trace: 300, sim_truth: 400 } as const;

const COALESCE_MS = 100;

/** u64 columns arrive as bigint; the app uses plain numbers (ids and timestamps fit in a double). */
export function plain<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out as T;
}

function rowsOf<T>(conn: LiveConn, name: string, cap?: number, sortKey?: string): T[] {
  const handle = conn.db[name];
  if (!handle) return [];
  let rows = Array.from(handle.iter(), (r) => plain<Record<string, unknown>>(r));
  if (sortKey) rows.sort((a, b) => Number(a[sortKey]) - Number(b[sortKey]));
  if (cap && rows.length > cap) rows = rows.slice(rows.length - cap);
  return rows as T[];
}

export function snapshot(conn: LiveConn, debug: boolean): Tables {
  return {
    anomaly_event: rowsOf(conn, "anomaly_event", CAPS.anomaly_event, "ts_ms"),
    track: rowsOf(conn, "track"),
    campaign: rowsOf(conn, "campaign"),
    agent_trace: rowsOf(conn, "agent_trace", CAPS.agent_trace, "ts_ms"),
    prediction: rowsOf(conn, "prediction"),
    alert: rowsOf(conn, "alert", undefined, "sent_ms"),
    sim_truth: debug ? rowsOf(conn, "sim_truth", CAPS.sim_truth, "ts_ms") : [],
    mock_phones: [],
  };
}

/** `label` names the host in error messages (e.g. "ws://localhost:3000"). */
export function createLiveSourceWith(connect: ConnectFn, debug: boolean, label = "Spacetime"): DataSource {
  return {
    mode: "live",
    start(onTables, onStatus: (s: ConnectionStatus, d?: string) => void) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let conn: LiveConn | null = null;
      let applied = false;

      const emit = () => {
        timer = null;
        if (!stopped && conn && applied) onTables(snapshot(conn, debug));
      };
      // Row callbacks arrive in bursts (a whole recluster at once); emit one snapshot per burst.
      const schedule = () => {
        if (!timer && !stopped) timer = setTimeout(emit, COALESCE_MS);
      };

      onStatus("connecting");
      const handle = connect({
        onConnect(c) {
          if (stopped) return;
          conn = c;
          const names: string[] = [...TABLES, ...(debug ? ["sim_truth"] : [])];
          for (const n of names) {
            const t = c.db[n];
            if (!t) continue;
            t.onInsert(schedule);
            t.onDelete(schedule);
            t.onUpdate(schedule);
          }
          c.subscriptionBuilder()
            .onApplied(() => {
              if (stopped) return;
              applied = true;
              onStatus("connected", "Live Spacetime");
              emit();
            })
            .onError(() => !stopped && onStatus("error", "Subscription failed. Is the module published with these tables?"))
            .subscribe(names.map((n) => `SELECT * FROM ${n}`));
        },
        onError(err) {
          if (!stopped) onStatus("error", `Could not connect to ${label}: ${err.message}`);
        },
        onDisconnect(err) {
          if (stopped) return;
          applied = false;
          onStatus("error", err ? `Disconnected from ${label}: ${err.message}` : `Disconnected from ${label}. Is the host up and the module published?`);
        },
      });

      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          handle.disconnect();
        } catch {
          // already closed
        }
      };
    },
  };
}
