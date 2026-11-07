import { createContext, useContext, type ReactNode } from "react";
import { useSpacetime, type SpacetimeState } from "./useSpacetime";

const Ctx = createContext<SpacetimeState | null>(null);

/** One connection for the whole app. Roles 1 and 2: call `useTables()` inside your component. */
export function SpacetimeProvider({ children }: { children: ReactNode }) {
  const state = useSpacetime();
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useTables(): SpacetimeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTables must be used inside <SpacetimeProvider>");
  return v;
}
