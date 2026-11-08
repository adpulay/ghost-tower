import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTables } from "../spacetime/SpacetimeContext";
import { towerMark } from "./symbols";

const FEED_LABEL = { connected: "Live", connecting: "Connecting…", error: "Connection lost" } as const;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function TopBar() {
  const { status, debug } = useTables();
  const { signOut } = useAuth();
  const now = useClock();

  return (
    <header className="topbar">
      <NavLink to="/" className="topbar-brand" aria-label="Ghost Tower home">
        <span className="topbar-mark" dangerouslySetInnerHTML={{ __html: towerMark(26) }} />
        <span className="topbar-word">Ghost Tower</span>
      </NavLink>

      <nav className="topbar-nav" aria-label="Views">
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/patrol">Patrol view</NavLink>
      </nav>

      <div className="topbar-right">
        {/* Always on: the fake tower and most phones are simulated, whatever the data source. */}
        <span className="topbar-chip" title="The fake tower and most phones in this demo are simulated">Simulated data</span>
        {debug && <span className="topbar-chip">Answer key shown</span>}
        <span className={`feed feed-${status}`} role="status">
          <i aria-hidden />
          {FEED_LABEL[status]}
        </span>
        <time className="clock" dateTime={now.toISOString()}>
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time>
        <button type="button" className="topbar-logout" onClick={signOut}>Log out</button>
      </div>
    </header>
  );
}
