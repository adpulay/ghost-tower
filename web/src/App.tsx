import { Route, Routes } from "react-router-dom";
import { AnalystMap } from "./map/AnalystMap";
import { ActivityFeed } from "./shell/ActivityFeed";
import { IncidentPanel } from "./shell/IncidentPanel";
import { PatrolSlot } from "./shell/Slots";
import { TopBar } from "./shell/TopBar";

export default function App() {
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
      <Route path="/patrol" element={<PatrolSlot />} />
    </Routes>
  );
}
