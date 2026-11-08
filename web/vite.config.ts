import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // One copy of react / react-dom for the app and for spacetimedb/react (installed at the repo root).
  resolve: { dedupe: ["react", "react-dom"] },
  // module_bindings re-exports ../spacetime/bindings, which lives outside web/.
  server: { host: true, port: 5173, fs: { allow: [".."] } },
});
