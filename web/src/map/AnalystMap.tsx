import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { parseLatLonList, type LatLon } from "../spacetime/geo";
import { useTables } from "../spacetime/SpacetimeContext";
import { hostileSvg, interceptSvg } from "../shell/symbols";
import { focusTrack } from "../spacetime/focusTrack";

const CENTER: LatLon = [32.9905, -96.7545]; // UTD / Campbell Rd, Richardson
const EVENT_WINDOW_MS = 120_000; // matches the recluster window
const FLASH_MS = 4_000;
/** After the user drags or zooms, leave the camera alone for this long. */
const USER_MOVED_HOLD_MS = 20_000;

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

const ALERT_ZONE = "#c99400";
const ALERT_FILL = "#f2b705";
const EVENT = "#f08a24";

export function AnalystMap() {
  const { tables, status, detail, mode, debug } = useTables();
  const [now, setNow] = useState(Date.now());

  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const dynamicRef = useRef<L.LayerGroup | null>(null);
  const trackMarkerRef = useRef<L.Marker | null>(null);
  const targetRef = useRef<LatLon | null>(null);
  const userMovedAtRef = useRef(0);
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
    // Our own panTo() fires neither of these, so they only mark real user movement.
    const markMoved = () => (userMovedAtRef.current = Date.now());
    map.on("dragstart", markMoved);
    map.on("zoomstart", markMoved);
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
        fillColor: ALERT_FILL,
        fillOpacity: flashing ? 0.35 : 0.18,
        className: flashing ? "zone-flash" : "",
      })
        .bindTooltip(`${alert.recipients} phones in this area were warned`)
        .addTo(layer);
    }

    // Predicted path + intercept.
    for (const p of tables.prediction) {
      const path = parseLatLonList(p.path_json);
      if (path.length > 1) {
        // White casing under a blue dashed core so the path reads on the grey basemap and on projectors.
        L.polyline(path, { color: "#ffffff", weight: 9, opacity: 0.95 }).addTo(layer);
        L.polyline(path, { color: "#1257c7", weight: 4, dashArray: "10 8" }).addTo(layer);
      }
      L.marker([p.intercept_lat, p.intercept_lon], { icon: interceptIcon })
        .bindTooltip("Where police can meet it")
        .addTo(layer);
    }

    // Grey dots: simulated phones (mock source only; there is no phone table).
    for (const ph of tables.mock_phones) {
      L.circleMarker([ph.lat, ph.lon], {
        radius: 3.5, stroke: false, fillColor: "#9aa4b2", fillOpacity: 0.7,
      }).addTo(layer);
    }

    // Orange dots: anomaly events, fading out over the 120 s window.
    for (const e of tables.anomaly_event) {
      const age = now - e.ts_ms;
      if (age > EVENT_WINDOW_MS || age < -5000) continue;
      const fade = Math.max(0.1, 1 - age / EVENT_WINDOW_MS);
      L.circleMarker([e.lat, e.lon], {
        radius: 6, color: "#ffffff", weight: 1.5, fillColor: EVENT, fillOpacity: fade, opacity: fade,
      })
        .bindTooltip(`Scam text${e.brand ? ` pretending to be ${e.brand}` : ""}, ${Math.max(0, Math.round(age / 1000))} s ago`)
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
    const f = focusTrack(tables.track);
    const t = f && (f.status === "active" || f.status === "candidate") ? f : undefined;
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
      t.status === "active" ? "Fake tower, best guess of where it is" : "Possible fake tower",
    );
    // Keep the blaster on screen: the real route can start well outside the default view, and the
    // legend covers a map corner, so recentre once it leaves the middle 60% of the view.
    if (Date.now() - userMovedAtRef.current > USER_MOVED_HOLD_MS && !map.getBounds().pad(-0.2).contains([t.lat, t.lon])) {
      map.panTo([t.lat, t.lon], { animate: true, duration: 1 });
    }
  }, [tables.track]);

  const focused = focusTrack(tables.track);
  const showTower = () => {
    const m = trackMarkerRef.current;
    if (!m || !mapRef.current) return;
    userMovedAtRef.current = 0;
    mapRef.current.setView(m.getLatLng(), Math.max(mapRef.current.getZoom(), 15), { animate: true });
  };
  const canShow = !!focused && (focused.status === "active" || focused.status === "candidate");

  return (
    <div className="map-wrap">
      <div className="map-host">
        <div ref={hostRef} className="map" />
        {status === "error" && (
          <div className="map-error" role="alert" title={detail}>
            Lost connection to live reports. The map will update again once it reconnects.
          </div>
        )}

        {canShow && (
          <button type="button" className="map-find" onClick={showTower}>
            Show the fake tower
          </button>
        )}

        <ul className="legend" aria-label="Map key">
          <li><span className="key" dangerouslySetInnerHTML={{ __html: hostileSvg(18) }} />Fake tower</li>
          <li><span className="key"><i className="key-dot key-event" /></span>Scam text received</li>
          <li><span className="key"><i className="key-path" /></span>Where it's heading</li>
          <li><span className="key"><i className="key-zone" /></span>Phones warned here</li>
          <li><span className="key" dangerouslySetInnerHTML={{ __html: interceptSvg(20) }} />Police meet point</li>
          {mode === "mock" && <li><span className="key"><i className="key-dot key-phone" /></span>Phones (demo)</li>}
        </ul>
      </div>
    </div>
  );
}
