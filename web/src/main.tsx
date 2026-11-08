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
import { AuthProvider } from "./auth/AuthContext";
import { SpacetimeProvider } from "./spacetime/SpacetimeContext";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SpacetimeProvider>
          <App />
        </SpacetimeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
