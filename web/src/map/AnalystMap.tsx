import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { parseLatLonList, pointInPolygon, type LatLon } from "../spacetime/geo";
import { useTables } from "../spacetime/SpacetimeContext";

const CENTER: LatLon = [32.9858, -96.7501]; // UTD / Campbell Rd, Richardson
const EVENT_WINDOW_MS = 120_000; // matches the recluster window
const FLASH_MS = 4_000;

const trackIcon = L.divIcon({
  className: "",
  html: '<div class="blaster-marker"></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});
const interceptIcon = L.divIcon({
  className: "intercept-icon",
  html: "★",
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

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
    const map = L.map(hostRef.current!, { zoomControl: true }).setView(CENTER, 14);
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
        color: "#f5c542",
        weight: flashing ? 4 : 2,
        fillColor: "#f5c542",
        fillOpacity: flashing ? 0.4 : 0.18,
        className: flashing ? "zone-flash" : "",
      })
        .bindTooltip(`Alert zone · ${alert.recipients} phones warned`)
        .addTo(layer);
    }

    // Predicted path + intercept.
    for (const p of tables.prediction) {
      const path = parseLatLonList(p.path_json);
      if (path.length > 1) {
        // White casing under a dark dashed core so the path reads on both light map tiles and projectors.
        L.polyline(path, { color: "#ffffff", weight: 9, opacity: 0.95 }).addTo(layer);
        L.polyline(path, { color: "#1e3a8a", weight: 4, dashArray: "10 8" }).addTo(layer);
      }
      L.marker([p.intercept_lat, p.intercept_lon], { icon: interceptIcon })
        .bindTooltip(`Intercept · ETA ${p.eta_s}s`)
        .addTo(layer);
    }

    // Grey dots: simulated phones (mock source only; there is no phone table).
    for (const ph of tables.mock_phones) {
      L.circleMarker([ph.lat, ph.lon], {
        radius: 5, color: "#6b7280", weight: 1, fillColor: "#9ca3af", fillOpacity: 0.7,
      }).addTo(layer);
    }

    // Orange dots: anomaly events, fading out over the 120 s window.
    for (const e of tables.anomaly_event) {
      const age = now - e.ts_ms;
      if (age > EVENT_WINDOW_MS || age < -5000) continue;
      const fade = Math.max(0.1, 1 - age / EVENT_WINDOW_MS);
      L.circleMarker([e.lat, e.lon], {
        radius: 7, color: "#c2410c", weight: 1, fillColor: "#fb923c", fillOpacity: fade, opacity: fade,
      })
        .bindTooltip(`${e.brand || "event"} · fusion ${e.fusion_score.toFixed(2)} · ${e.source}`)
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
      `Track ${t.id} · ${t.status} · conf ${(t.confidence * 100).toFixed(0)}% · ${t.speed_mps.toFixed(0)} m/s`,
    );
  }, [tables.track]);

  const live = tables.anomaly_event.filter((e) => now - e.ts_ms <= EVENT_WINDOW_MS).length;
  // There are no phone ids in the schema, so "hit after warning" counts distinct reports that land
  // inside an alert zone after that alert was sent.
  const hitAfterWarning = useMemo(() => {
    const hit = new Set<number>();
    for (const a of tables.alert) {
      const zone = parseLatLonList(a.zone_json);
      if (zone.length < 3) continue;
      for (const e of tables.anomaly_event) {
        if (e.ts_ms > a.sent_ms && pointInPolygon([e.lat, e.lon], zone)) hit.add(e.id);
      }
    }
    return hit.size;
  }, [tables.alert, tables.anomaly_event]);
  const warned = tables.alert.reduce((s, a) => s + a.recipients, 0);
  const track = tables.track[tables.track.length - 1];
  const campaign = tables.campaign[tables.campaign.length - 1];

  return (
    <div className="map-wrap">
      <div ref={hostRef} className="map" />

      <div className="hud hud-top">
        <div className="title">GHOST TOWER</div>
        <div className={`pill pill-${status}`}>
          {status === "connected" ? "● live" : status}
        </div>
        {mode === "mock" && <div className="pill pill-sim">simulated data</div>}
        {debug && <div className="pill pill-debug">debug: ground truth visible</div>}
        {status === "error" && <div className="error">{detail}</div>}
      </div>

      <div className="hud hud-stats">
        <div><b>{live}</b><span>reports (120 s)</span></div>
        <div><b>{warned}</b><span>phones warned</span></div>
        <div><b>{hitAfterWarning}</b><span>hit after warning</span></div>
        <div><b>{track ? track.status : "—"}</b><span>track</span></div>
        <div><b>{campaign ? campaign.brand : "—"}</b><span>campaign</span></div>
      </div>

      <div className="hud hud-legend">
        <div><i className="dot grey" /> phones {mode === "mock" && <em>(simulated)</em>}</div>
        <div><i className="dot orange" /> anomaly events</div>
        <div><i className="dot red" /> blaster estimate</div>
        <div><i className="dash" /> predicted path</div>
        <div><i className="dot zone" /> alert zone</div>
        <div><i className="star">★</i> intercept point</div>
      </div>
    </div>
  );
}
