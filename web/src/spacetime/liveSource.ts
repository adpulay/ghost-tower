import { DbConnection, SPACETIME_HOST } from "../module_bindings";
import { createLiveSourceWith, type LiveConn } from "./liveCore";
import type { DataSource } from "./types";

/**
 * Live Spacetime subscriptions through Role 1's bindings (spacetime/bindings, re-exported by
 * module_bindings). `uri` may be http(s):// or ws(s)://; empty falls back to the bindings'
 * default (SPACETIME_HOST, ws://localhost:3000). The core logic lives in liveCore.ts.
 */
export function createLiveSource(uri: string, dbName: string, debug: boolean): DataSource {
  const target = uri.replace(/^http/, "ws") || SPACETIME_HOST;
  return createLiveSourceWith((h) => {
    const conn = DbConnection.builder()
      .withUri(target)
      .withDatabaseName(dbName)
      .onConnect((c) => h.onConnect(c as unknown as LiveConn))
      .onConnectError((_ctx, err) => h.onError(err))
      .onDisconnect((_ctx, err) => h.onDisconnect(err ?? undefined))
      .build();
    return { disconnect: () => conn.disconnect() };
  }, debug, `${target} (${dbName})`);
}
