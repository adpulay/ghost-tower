import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useTables } from "../spacetime/SpacetimeContext";
import { towerMark } from "./symbols";

const FEED_LABEL = { connected: "Live feed", connecting: "Connecting", error: "Feed down" } as const;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function TopBar() {
  const { status, mode, debug } = useTables();
  const now = useClock();
  const time = now.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const zone = now.toLocaleTimeString([], { timeZoneName: "short" }).split(" ").pop();

  return (
    <header className="topbar">
      <NavLink to="/" className="topbar-brand" aria-label="Ghost Tower, analyst map">
        <span className="topbar-mark" dangerouslySetInnerHTML={{ __html: towerMark(30) }} />
        <span className="topbar-word">Ghost Tower</span>
      </NavLink>
      <span className="topbar-place">Fake cell site watch, Richardson TX</span>

      <nav className="topbar-nav" aria-label="Views">
        <NavLink to="/" end>Analyst map</NavLink>
        <NavLink to="/patrol">Patrol tablet</NavLink>
      </nav>

      <div className="topbar-right">
        {mode === "mock" && <span className="flag flag-sim">Simulated data</span>}
        {debug && <span className="flag flag-debug">Ground truth visible</span>}
        <span className={`feed feed-${status}`} role="status">
          <i aria-hidden />
          {FEED_LABEL[status]}
        </span>
        <time className="clock" dateTime={now.toISOString()}>
          {time}
          <small>{zone}</small>
        </time>
      </div>
    </header>
  );
}
