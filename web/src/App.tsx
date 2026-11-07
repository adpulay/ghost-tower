import { Route, Routes } from "react-router-dom";
import { AnalystMap } from "./map/AnalystMap";
import { PatrolSlot, TracePanelSlot } from "./shell/Slots";

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="layout">
            <AnalystMap />
            <TracePanelSlot />
          </div>
        }
      />
      <Route path="/patrol" element={<PatrolSlot />} />
    </Routes>
  );
}
