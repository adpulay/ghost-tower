// Patrol tablet (A.md Phase 5): where to go, nothing else. Big map following the active
// track, the intercept star, an ETA countdown, the predicted route line, and one status line
// that updates on each `replan` trace row. Held by a judge, so everything is large.
//
// Mount it at /patrol inside Role 3's app shell, under their SpacetimeDBProvider:
//   <Route path="/patrol" element={<PatrolView />} />
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './patrol.css';
import { usePatrolData } from './usePatrolData.ts';
import { hostileSvg, interceptSvg } from '../shell/symbols';
import {
  activeTracks, compass, etaRemaining, formatEta, parsePath, pickTarget, statusLine, type TrackRow,
} from './patrolModel.ts';

const UTD: [number, number] = [32.9857, -96.7502];

const interceptIcon = L.divIcon({
  className: 'sym',
  html: interceptSvg(60, '#1257c7'),
  iconSize: [60, 60],
  iconAnchor: [30, 30],
});
const targetIcon = L.divIcon({
  className: 'sym sym-hostile patrol-hostile',
  html: hostileSvg(44),
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Keeps the camera on the target (and the intercept, if any) unless the officer is panning. */
function FollowCamera({ target, intercept }: { target?: TrackRow; intercept?: [number, number] }) {
  const map = useMap();
  const [userMoved, setUserMoved] = useState(false);
  useEffect(() => {
    const onDrag = () => setUserMoved(true);
    map.on('dragstart', onDrag);
    return () => {
      map.off('dragstart', onDrag);
    };
  }, [map]);
  useEffect(() => {
    if (!target || userMoved) return;
    const here: [number, number] = [target.lat, target.lon];
    if (intercept) map.flyToBounds(L.latLngBounds([here, intercept]).pad(0.35), { maxZoom: 16, duration: 0.8 });
    else map.flyTo(here, Math.max(map.getZoom(), 15), { duration: 0.8 });
  }, [map, target?.lat, target?.lon, intercept?.[0], intercept?.[1], userMoved]);
  return userMoved ? (
    <button className="patrol-btn patrol-recenter" onClick={() => setUserMoved(false)}>
      Re-center
    </button>
  ) : null;
}

export default function PatrolView() {
  const { tracks, predictions, traces, ready } = usePatrolData();
  const now = useNow();
  const [chosen, setChosen] = useState<bigint | null>(null);

  const active = useMemo(() => activeTracks(tracks), [tracks]);
  const target = pickTarget(tracks, chosen);
  const prediction = target ? predictions.find(p => p.track_id === target.id) : undefined;
  const path = useMemo(() => (prediction ? parsePath(prediction.path_json) : []), [prediction?.path_json]);
  const intercept: [number, number] | undefined = prediction ? [prediction.intercept_lat, prediction.intercept_lon] : undefined;
  const eta = prediction ? etaRemaining(prediction, now) : undefined;
  const line = statusLine(target, traces, prediction, now);

  return (
    <div className="patrol">
      <header className="patrol-status" role="status" aria-live="polite">
        <span className={`patrol-dot ${target ? 'live' : ''}`} />
        <span className="patrol-status-text">{ready ? line : 'Connecting…'}</span>
      </header>

      <MapContainer className="patrol-map" center={UTD} zoom={14} zoomControl={false} attributionControl>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap contributors"
        />
        {path.length > 1 && <Polyline positions={path} pathOptions={{ className: 'patrol-route-casing', weight: 12 }} />}
        {path.length > 1 && <Polyline positions={path} pathOptions={{ className: 'patrol-route', weight: 6 }} />}
        {intercept && <Marker position={intercept} icon={interceptIcon} title="Intercept point" />}
        {target && (
          <Marker position={[target.lat, target.lon]} icon={targetIcon} title="Target" zIndexOffset={1000} />
        )}
        <FollowCamera target={target} intercept={intercept} />
      </MapContainer>

      <footer className="patrol-footer">
        <div className="patrol-eta">
          <div className="patrol-eta-label">Get to the intercept in</div>
          <div className="patrol-eta-value">{eta === undefined ? '—' : formatEta(eta)}</div>
        </div>
        <div className="patrol-target-info">
          {target ? (
            <>
              <div className="patrol-big">Target {String(target.id)}</div>
              <div className="patrol-sub">
                {target.speed_mps >= 1
                  ? `Heading ${compass(target.heading_deg)}, ${Math.round(target.speed_mps * 3.6)} km/h`
                  : 'Stationary'}
              </div>
            </>
          ) : (
            <div className="patrol-big">No active target</div>
          )}
        </div>
        {active.length > 1 && (
          <div className="patrol-switch" aria-label="choose target">
            {active.map(t => (
              <button
                key={String(t.id)}
                className={`patrol-btn ${t.id === target?.id ? 'on' : ''}`}
                onClick={() => setChosen(t.id)}
              >
                Target {String(t.id)}
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
