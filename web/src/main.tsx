import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "leaflet/dist/leaflet.css";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow/700.css";
import "@fontsource/barlow/800.css";
import "@fontsource/barlow-condensed/600.css";
import "./styles.css";
import App from "./App";
import { SpacetimeProvider } from "./spacetime/SpacetimeContext";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SpacetimeProvider>
        <App />
      </SpacetimeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
