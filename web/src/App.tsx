import { Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { LoginScreen } from "./auth/LoginScreen";
import { AnalystMap } from "./map/AnalystMap";
import { ActivityFeed } from "./shell/ActivityFeed";
import { IncidentPanel } from "./shell/IncidentPanel";
import PatrolView from "./patrol/PatrolView";
import { TopBar } from "./shell/TopBar";

export default function App() {
  const { authed } = useAuth();
  if (!authed) return <LoginScreen />;

  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="console">
            <TopBar />
            <div className="console-body">
              <main className="console-side">
                <IncidentPanel />
                <ActivityFeed />
              </main>
              <AnalystMap />
            </div>
          </div>
        }
      />
      <Route path="/patrol" element={<PatrolView />} />
    </Routes>
  );
}
