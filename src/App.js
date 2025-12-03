import React, { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Polygon,
  Tooltip,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

/* ---------------- TOWER ICON ---------------- */
const towerIcon = L.divIcon({
  className: "tower-icon",
  html: `<div style="
    width:20px;height:20px;
    background:#007bff;border:2px solid white;border-radius:50%;
    box-shadow:0 2px 2px rgba(0,0,0,0.2);"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

/* ---------------- HELPERS ---------------- */
function parseFreqHz(freq) {
  if (!freq) return NaN;
  const s = String(freq).trim().toLowerCase();
  if (s.endsWith("ghz")) return parseFloat(s) * 1e9;
  if (s.endsWith("mhz")) return parseFloat(s) * 1e6;
  if (s.endsWith("hz")) return parseFloat(s);
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return n >= 1 ? n * 1e9 : n * 1e6;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const x1 = (a.lat * Math.PI) / 180;
  const x2 = (b.lat * Math.PI) / 180;
  const dx = ((b.lat - a.lat) * Math.PI) / 180;
  const dy = ((b.lng - a.lng) * Math.PI) / 180;

  const s1 = Math.sin(dx / 2);
  const s2 = Math.sin(dy / 2);
  const aa = s1 * s1 + Math.cos(x1) * Math.cos(x2) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

function bearingBetween(a, b) {
  const x1 = (a.lat * Math.PI) / 180;
  const x2 = (b.lat * Math.PI) / 180;
  const y1 = (a.lng * Math.PI) / 180;
  const y2 = (b.lng * Math.PI) / 180;

  const y = Math.sin(y2 - y1) * Math.cos(x2);
  const x =
    Math.cos(x1) * Math.sin(x2) -
    Math.sin(x1) * Math.cos(x2) * Math.cos(y2 - y1);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function fresnelRadius(lambda, d1, d2) {
  if (d1 + d2 === 0) return 0;
  return Math.sqrt((lambda * d1 * d2) / (d1 + d2));
}

function computeSimpleFresnel(a, b, freqHz) {
  const d = distanceMeters(a, b);
  const lambda = 3e8 / freqHz;
  const rMid = fresnelRadius(lambda, d / 2, d / 2);
  return { totalDist: d, rMidMeters: rMid };
}

/* ---------------- FIXED ELLIPSE GENERATOR ---------------- */
function generateFresnelEllipse(lat1, lon1, lat2, lon2, rMid, steps = 180) {
  const R = 6371000;

  // Safe projection helper
  function destPoint(lat, lon, bearingDeg, distance) {
    const b = (bearingDeg * Math.PI) / 180;
    const x1 = (lat * Math.PI) / 180;
    const y1 = (lon * Math.PI) / 180;
    const d = distance / R;

    const x2 =
      Math.asin(
        Math.sin(x1) * Math.cos(d) +
          Math.cos(x1) * Math.sin(d) * Math.cos(b)
      );

    const y2 =
      y1 +
      Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(x1),
        Math.cos(d) - Math.sin(x1) * Math.sin(x2)
      );

    return { lat: (x2 * 180) / Math.PI, lon: (y2 * 180) / Math.PI };
  }

  const totalDist = distanceMeters({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 });

  /* 
    FIX #1:
    Reduce axis sizes so Leaflet always renders safely.
    Raw meters are too large for projection after Vercel minification.
  */
  const semiMajor = (totalDist / 2) / 2000;   // Convert -> km and shrink further
  const semiMinor = rMid / 50;                // shrink Fresnel height

  const bearing = bearingBetween({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 });

  const centerLat = (lat1 + lat2) / 2;
  const centerLon = (lon1 + lon2) / 2;

  const points = [];

  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * 2 * Math.PI;

    const x = semiMajor * Math.cos(θ);
    const y = semiMinor * Math.sin(θ);

    const p1 = destPoint(centerLat, centerLon, bearing, x);
    const pFinal = destPoint(p1.lat, p1.lon, bearing + 90, y);

    points.push([pFinal.lat, pFinal.lon]);
  }

  return points;
}

/* -------------- ADD TOWER ON CLICK ---------------- */
function AddTowerOnClick({ onAdd }) {
  useMapEvents({
    click(e) {
      onAdd({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

/* ---------------- MAIN ---------------- */
export default function RFLinkPlanner() {
  const [towers, setTowers] = useState([]);
  const [links, setLinks] = useState([]);
  const [selectedTower, setSelectedTower] = useState(null);
  const [selectedLink, setSelectedLink] = useState(null);
  const [message, setMessage] = useState("Click map to add towers");
  const linkId = useRef(1);

  const SCALE_FACTOR = 1; // FIXED

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(t);
  }, [message]);

  /* ------------ Add Tower ------------ */
  function addTower(pos) {
    setTowers((prev) => {
      const newId = prev.length === 0 ? 1 : Math.max(...prev.map((p) => p.id)) + 1;
      return [...prev, { id: newId, lat: pos.lat, lng: pos.lng, freqStr: "5 GHz" }];
    });
  }

  /* ------------ Update Tower ------------ */
  function updateTower(id, patch) {
    setTowers((prev) => {
      const updated = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));

      setLinks((prevLinks) =>
        prevLinks
          .map((lnk) => {
            const a = updated.find((t) => t.id === lnk.aId);
            const b = updated.find((t) => t.id === lnk.bId);

            if (!a || !b) return null;
            if (parseFreqHz(a.freqStr) !== parseFreqHz(b.freqStr)) return null;

            return lnk;
          })
          .filter(Boolean)
      );

      return updated;
    });

    setSelectedLink(null);
  }

  /* ------------ Remove Tower ------------ */
  function removeTower(id) {
    setTowers((prev) => prev.filter((t) => t.id !== id));
    setLinks((prev) => prev.filter((l) => l.aId !== id && l.bId !== id));
    setSelectedTower(null);
  }

  /* ------------ Create Link ------------ */
  function createLink(aId, bId) {
    if (aId === bId) return;

    const a = towers.find((t) => t.id === aId);
    const b = towers.find((t) => t.id === bId);

    if (!a || !b) return;
    if (parseFreqHz(a.freqStr) !== parseFreqHz(b.freqStr)) {
      setMessage("Frequencies do not match");
      return;
    }

    if (links.some((l) =>
      (l.aId === aId && l.bId === bId) ||
      (l.aId === bId && l.bId === aId)
    )) {
      setMessage("Link already exists");
      return;
    }

    setLinks((prev) => [...prev, { id: linkId.current++, aId, bId, freqStr: a.freqStr }]);
  }

  /* ------------ Show Fresnel ------------ */
  function onLinkClick(l) {
    setSelectedLink(l.id);

    const a = towers.find((t) => t.id === l.aId);
    const b = towers.find((t) => t.id === l.bId);

    if (!a || !b) return;

    const freqHz = parseFreqHz(l.freqStr);
    const fresnelInfo = computeSimpleFresnel(a, b, freqHz);

    const pts = generateFresnelEllipse(
      a.lat,
      a.lng,
      b.lat,
      b.lng,
      fresnelInfo.rMidMeters * SCALE_FACTOR
    );

    setLinks((prev) =>
      prev.map((x) =>
        x.id === l.id
          ? {
              ...x,
              fresnel: {
                polygonPoints: pts,
                rMidMeters: fresnelInfo.rMidMeters,
                distance: fresnelInfo.totalDist,
                freq: l.freqStr,
              },
            }
          : x
      )
    );
  }

  /* ------------ Render UI ------------ */
  return (
    <div className="layout-container">
      <div className="map-section">
        <MapContainer center={[22.5, 77.5]} zoom={6} className="map-element">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          <AddTowerOnClick onAdd={addTower} />

          {/* Towers */}
          {towers.map((t) => (
            <Marker
              key={t.id}
              icon={towerIcon}
              position={[t.lat, t.lng]}
              eventHandlers={{
                click: () => {
                  if (!selectedTower) {
                    setSelectedTower(t.id);
                    return;
                  }
                  if (selectedTower === t.id) {
                    setSelectedTower(null);
                    return;
                  }
                  createLink(selectedTower, t.id);
                  setSelectedTower(null);
                },
              }}
            />
          ))}

          {/* Links + Ellipse */}
          {links.map((l) => {
            const a = towers.find((t) => t.id === l.aId);
            const b = towers.find((t) => t.id === l.bId);
            if (!a || !b) return null;

            return (
              <React.Fragment key={l.id}>
                <Polyline
                  positions={[
                    [a.lat, a.lng],
                    [b.lat, b.lng],
                  ]}
                  eventHandlers={{
                    click: (event) => {
                      event.originalEvent.stopPropagation();
                      onLinkClick(l);
                    },
                  }}
                >
                  <Tooltip>
                    Distance: {(distanceMeters(a, b) / 1000).toFixed(2)} km <br />
                    Frequency: {l.freqStr}
                  </Tooltip>
                </Polyline>

                {selectedLink === l.id && l.fresnel?.polygonPoints && (
                  <Polygon
                    positions={l.fresnel.polygonPoints}
                    pathOptions={{
                      color: "limegreen",
                      fillColor: "rgba(0,255,0,0.18)",
                      weight: 2,
                    }}
                    eventHandlers={{
                      click: (event) => event.originalEvent.stopPropagation(),
                    }}
                  >
                    <Tooltip sticky>
                      <strong>Fresnel Radius:</strong>{" "}
                      {l.fresnel.rMidMeters.toFixed(2)} m
                      <br />
                      <strong>Distance:</strong>{" "}
                      {(l.fresnel.distance / 1000).toFixed(2)} km
                      <br />
                      <strong>Frequency:</strong> {l.fresnel.freq}
                    </Tooltip>
                  </Polygon>
                )}
              </React.Fragment>
            );
          })}
        </MapContainer>
      </div>

      {/* Sidebar */}
      <aside className="sidebar">
        <h2>RF Link Planner</h2>
        <p>{message}</p>

        <h3>Towers</h3>
        {towers.map((t) => (
          <div key={t.id} className="tower-card">
            <strong>Tower {t.id}</strong>
            <div className="coords">
              {t.lat.toFixed(4)}, {t.lng.toFixed(4)}
            </div>
            <input
              value={t.freqStr}
              className="freq-input"
              onChange={(e) => updateTower(t.id, { freqStr: e.target.value })}
            />
            <div className="tower-buttons">
              <button onClick={() => setSelectedTower(t.id)}>
                {selectedTower === t.id ? "Selected" : "Select"}
              </button>
              <button className="remove-btn" onClick={() => removeTower(t.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}

        <h3>Links</h3>
        {links.map((l) => {
          const a = towers.find((t) => t.id === l.aId);
          const b = towers.find((t) => t.id === l.bId);

          return (
            <div key={l.id} className="link-card">
              <strong>Link {l.id}</strong>
              <div className="coords">
                {l.aId} ↔ {l.bId} ·{" "}
                {(distanceMeters(a, b) / 1000).toFixed(2)} km · {l.freqStr}
              </div>
              <div className="link-buttons">
                <button onClick={() => onLinkClick(l)}>Show Fresnel</button>
                <button
                  className="remove-btn"
                  onClick={() => removeLink(l.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        <ol className="steps">
          <h4>STEP 1</h4>
          <li>Click on the map to add a tower.</li>
          <h4>STEP 2</h4>
          <li>Select two towers with matching frequency.</li>
          <h4>STEP 3</h4>
          <li>Click “Show Fresnel” to visualize the zone.</li>
        </ol>
      </aside>
    </div>
  );
}
