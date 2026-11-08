import { Route, Routes } from "react-router-dom";
import { AnalystMap } from "./map/AnalystMap";
import { IncidentPanel } from "./shell/IncidentPanel";
import { PatrolSlot, TracePanelSlot } from "./shell/Slots";
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
              <AnalystMap />
              <aside className="console-side">
                <IncidentPanel />
                <TracePanelSlot />
              </aside>
            </div>
          </div>
        }
      />
      <Route path="/patrol" element={<PatrolSlot />} />
    </Routes>
  );
}
