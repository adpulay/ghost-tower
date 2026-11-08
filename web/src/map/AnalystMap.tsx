import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { parseLatLonList, type LatLon } from "../spacetime/geo";
import { useTables } from "../spacetime/SpacetimeContext";
import { FRIENDLY, hostileSvg, interceptSvg } from "../shell/symbols";

const CENTER: LatLon = [32.9905, -96.7545]; // UTD / Campbell Rd, Richardson
const EVENT_WINDOW_MS = 120_000; // matches the recluster window
const FLASH_MS = 4_000;

const trackIcon = L.divIcon({
  className: "sym sym-hostile",
  html: hostileSvg(32),
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});
const interceptIcon = L.divIcon({
  className: "sym",
  html: interceptSvg(38),
  iconSize: [38, 38],
  iconAnchor: [19, 19],
});

const ALERT_ZONE = "#f2b705";
const EVENT = "#f08a24";

export function AnalystMap() {
  const { tables, status, detail, mode, debug } = useTables();
  const [now, setNow] = useState(Date.now());

  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const dynamicRef = useRef<L.LayerGroup | null>(null);
  const trackMarkerRef = useRef<L.Marker | null>(null);
  const targetRef = useRef<LatLon | null>(null);
  const lastAlertRef = useRef<{ id: number; at: number }>({ id: 0, at: 0 });

  // Events fade on wall-clock time even when no new rows arrive.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const map = L.map(hostRef.current!, { zoomControl: true }).setView(CENTER, 15);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    mapRef.current = map;
    dynamicRef.current = L.layerGroup().addTo(map);

    // Smooth track marker: ease toward the latest estimate every frame.
    let raf = 0;
    const step = () => {
      const m = trackMarkerRef.current;
      const t = targetRef.current;
      if (m && t) {
        const cur = m.getLatLng();
        const k = 0.12;
        m.setLatLng([cur.lat + (t[0] - cur.lat) * k, cur.lng + (t[1] - cur.lng) * k]);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      trackMarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = dynamicRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    // Alert zone, with a brief highlight when a new warning goes out.
    const alert = tables.alert[tables.alert.length - 1];
    if (alert && alert.id !== lastAlertRef.current.id) {
      lastAlertRef.current = { id: alert.id, at: Date.now() };
    }
    if (alert) {
      const flashing = now - lastAlertRef.current.at < FLASH_MS;
      L.polygon(parseLatLonList(alert.zone_json), {
        color: ALERT_ZONE,
        weight: flashing ? 3 : 2,
        fillColor: ALERT_ZONE,
        fillOpacity: flashing ? 0.3 : 0.12,
        className: flashing ? "zone-flash" : "",
      })
        .bindTooltip(`Alert zone: ${alert.recipients} phones warned`)
        .addTo(layer);
    }

    // Predicted path + intercept.
    for (const p of tables.prediction) {
      const path = parseLatLonList(p.path_json);
      if (path.length > 1) {
        L.polyline(path, { color: "#08111e", weight: 7, opacity: 0.7 }).addTo(layer);
        L.polyline(path, { color: FRIENDLY, weight: 3, dashArray: "2 9", lineCap: "square", opacity: 1 }).addTo(layer);
      }
      L.marker([p.intercept_lat, p.intercept_lon], { icon: interceptIcon })
        .bindTooltip(`Intercept point, ETA ${p.eta_s} s at prediction`)
        .addTo(layer);
    }

    // Grey dots: simulated phones (mock source only; there is no phone table).
    for (const ph of tables.mock_phones) {
      L.circleMarker([ph.lat, ph.lon], {
        radius: 3.5, stroke: false, fillColor: "#8396ae", fillOpacity: 0.55,
      }).addTo(layer);
    }

    // Orange dots: anomaly events, fading out over the 120 s window.
    for (const e of tables.anomaly_event) {
      const age = now - e.ts_ms;
      if (age > EVENT_WINDOW_MS || age < -5000) continue;
      const fade = Math.max(0.1, 1 - age / EVENT_WINDOW_MS);
      L.circleMarker([e.lat, e.lon], {
        radius: 6, color: "#08111e", weight: 1.5, fillColor: EVENT, fillOpacity: fade, opacity: fade,
      })
        .bindTooltip(`${e.brand || "Unbranded"} report, fusion ${e.fusion_score.toFixed(2)}, from ${e.source}`)
        .addTo(layer);
    }

    // Ground truth: only ever present when ?debug=1 (the hook strips it otherwise).
    if (debug) {
      for (const t of tables.sim_truth) {
        L.circleMarker([t.lat, t.lon], { radius: 2, color: "#22c55e", weight: 1, fillOpacity: 1 }).addTo(layer);
      }
    }
  }, [tables, now, debug]);

  // Blaster estimate: persistent marker so it can glide between updates.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = tables.track.filter((t) => t.status === "active" || t.status === "candidate");
    const t = shown[shown.length - 1];
    if (!t) {
      if (trackMarkerRef.current) {
        trackMarkerRef.current.remove();
        trackMarkerRef.current = null;
      }
      targetRef.current = null;
      return;
    }
    targetRef.current = [t.lat, t.lon];
    if (!trackMarkerRef.current) {
      trackMarkerRef.current = L.marker([t.lat, t.lon], { icon: trackIcon, zIndexOffset: 1000 }).addTo(map);
    }
    trackMarkerRef.current.bindTooltip(
      `Track ${t.id}, ${t.status}, ${(t.confidence * 100).toFixed(0)}% confidence`,
    );
  }, [tables.track]);

  return (
    <div className="map-wrap">
      <div ref={hostRef} className="map" />
      {status === "error" && <div className="feed-banner" role="alert">Feed down: {detail}</div>}

      <ul className="legend" aria-label="Map key">
        <li>
          <span dangerouslySetInnerHTML={{ __html: hostileSvg(18) }} />
          Blaster, estimated position
        </li>
        <li>
          <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="5" fill={EVENT} stroke="#08111e" strokeWidth="1.5" /></svg>
          Phone report, fades over 2 min
        </li>
        <li>
          <svg viewBox="0 0 18 18"><path d="M1 9h16" stroke={FRIENDLY} strokeWidth="3" strokeDasharray="2 4" /></svg>
          Predicted route
        </li>
        <li>
          <span dangerouslySetInnerHTML={{ __html: interceptSvg(18) }} />
          Intercept point
        </li>
        <li>
          <svg viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" fill={ALERT_ZONE} fillOpacity=".25" stroke={ALERT_ZONE} strokeWidth="2" /></svg>
          Warning sent to phones here
        </li>
        <li>
          <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="3.5" fill="#8396ae" fillOpacity=".8" /></svg>
          Phones {mode === "mock" && <em>simulated</em>}
        </li>
      </ul>
    </div>
  );
}
