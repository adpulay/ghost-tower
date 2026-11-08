import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Demo-only access gate. The credentials are hardcoded and the check runs in the browser,
 * so this keeps a casual viewer out of the console for a hackathon demo — it is NOT real
 * security. Anyone can read these values in the page source. Do not put anything sensitive
 * behind it.
 */
const DEMO_USER = "admin";
const DEMO_PASS = "GhostTower$123";
const SESSION_KEY = "gt-auth";

function readSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

type AuthValue = {
  authed: boolean;
  /** Returns true on success, false on a bad username/password. */
  signIn: (user: string, pass: string) => boolean;
  signOut: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(readSession);

  const signIn = useCallback((user: string, pass: string) => {
    const ok = user.trim() === DEMO_USER && pass === DEMO_PASS;
    if (ok) {
      try {
        sessionStorage.setItem(SESSION_KEY, "1");
      } catch {
        /* private window: session stays in memory only */
      }
      setAuthed(true);
    }
    return ok;
  }, []);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    setAuthed(false);
  }, []);

  const value = useMemo(() => ({ authed, signIn, signOut }), [authed, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
