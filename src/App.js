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

  const Dx = Math.sin(dx / 2);
  const Dy = Math.sin(dy / 2);

  const val = Dx * Dx + Math.cos(x1) * Math.cos(x2) * Dy * Dy;

  const c = 2 * Math.atan2(Math.sqrt(val), Math.sqrt(1 - val));

  return R * c;
}

function bearingBetween(a, b) {
  const x1 = (a.lat * Math.PI) / 180;
  const x2 = (b.lat * Math.PI) / 180;

  const y1 = (a.lng * Math.PI) / 180;
  const y2 = (b.lng * Math.PI) / 180;
  const dy = y2 - y1;
  const y = Math.sin(dy) * Math.cos(x2);
  const x =
    Math.cos(x1) * Math.sin(x2) - Math.sin(x1) * Math.cos(x2) * Math.cos(dy);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
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

/* ---------------- ELLIPSE GENERATOR ---------------- */
function generateFresnelEllipse(
  lat1,
  lon1,
  lat2,
  lon2,
  rMidMeters,
  steps = 180
) {
function destPoint(lat, lon, bearingDeg, dist) {
  const R = 6371000;
  const brg = (bearingDeg * Math.PI) / 180;

  const x1 = (lat * Math.PI) / 180;
  const y1 = (lon * Math.PI) / 180;

  const dRad = dist / R;

  const x2 = Math.asin(
    Math.sin(x1) * Math.cos(dRad) +
      Math.cos(x1) * Math.sin(dRad) * Math.cos(brg)
  );

  const y2 =
    y1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(dRad) * Math.cos(x1),
      Math.cos(dRad) - Math.sin(x1) * Math.sin(x2)
    );

  return {
    lat: (x2 * 180) / Math.PI,
    lon: (y2 * 180) / Math.PI,
  };
}


  const d = distanceMeters({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 });
  const semiMajor = d / 2;
  const semiMinor = rMidMeters;
  const bearing = bearingBetween(
    { lat: lat1, lng: lon1 },
    { lat: lat2, lng: lon2 }
  );

  const centerLat = (lat1 + lat2) / 2;
  const centerLon = (lon1 + lon2) / 2;

  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * 2 * Math.PI;

    const x = semiMajor * Math.cos(θ);
    const y = semiMinor * Math.sin(θ);

    const p1 = destPoint(centerLat, centerLon, bearing, x);
    const p2 = destPoint(p1.lat, p1.lon, bearing + 90, y);

    pts.push([p2.lat, p2.lon]);
  }

  return pts;
}

/* -------------- ADD TOWER ON MAP CLICK ---------------- */
function AddTowerOnClick({ onAdd }) {
  useMapEvents({
    click(e) {
      onAdd({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

/* ---------------- MAIN COMPONENT ---------------- */
export default function RFLinkPlanner() {
  const [towers, setTowers] = useState([]);
  const [links, setLinks] = useState([]);
  const [selectedTower, setSelectedTower] = useState(null);
  const [selectedLink, setSelectedLink] = useState(null);
  const [message, setMessage] = useState(
    "Click map to add towers (default 5 GHz)"
  );
  const linkId = useRef(1);

  const SCALE_FACTOR = 400;

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(t);
  }, [message]);

  /* ------------ ADD TOWER ------------ */
  function addTower(pos) {
    setTowers((prev) => {
      const newId =
        prev.length === 0 ? 1 : Math.max(...prev.map((p) => p.id)) + 1;
      return [
        ...prev,
        { id: newId, lat: pos.lat, lng: pos.lng, freqStr: "5 GHz" },
      ];
    });
  }

  /* ------------ UPDATE TOWER ------------ */
  function updateTower(id, patch) {
    setTowers((prev) => {
      const updated = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));

      // remove invalid links
      setLinks((prevLinks) =>
        prevLinks
          .map((lnk) => {
            const a = updated.find((t) => t.id === lnk.aId);
            const b = updated.find((t) => t.id === lnk.bId);

            if (!a || !b) return null;

            const fa = parseFreqHz(a.freqStr);
            const fb = parseFreqHz(b.freqStr);

            if (
              isNaN(fa) ||
              isNaN(fb) ||
              Math.abs(fa - fb) > 1e-6 * Math.max(fa, fb)
            )
              return null;

            return lnk;
          })
          .filter(Boolean)
      );

      return updated;
    });

    setSelectedLink(null);
  }

  /* ------------ REMOVE TOWER ------------ */
  function removeTower(id) {
    setTowers((prev) => prev.filter((t) => t.id !== id));
    setLinks((prev) => prev.filter((l) => l.aId !== id && l.bId !== id));
    setSelectedTower(null);
  }

  /* ------------ CREATE LINK ------------ */
  function canLink(a, b) {
    const fa = parseFreqHz(a.freqStr);
    const fb = parseFreqHz(b.freqStr);
    if (isNaN(fa) || isNaN(fb)) return false;
    return Math.abs(fa - fb) <= 1e-6 * Math.max(fa, fb);
  }

  function createLink(aId, bId) {
    if (aId === bId) return;

    const a = towers.find((t) => t.id === aId);
    const b = towers.find((t) => t.id === bId);

    if (!a || !b) return;
    if (!canLink(a, b)) {
      setMessage("Frequencies do not match");
      return;
    }

    if (
      links.some(
        (l) =>
          (l.aId === aId && l.bId === bId) || (l.aId === bId && l.bId === aId)
      )
    ) {
      setMessage("Link already exists");
      return;
    }

    const id = linkId.current++;
    setLinks((prev) => [...prev, { id, aId, bId, freqStr: a.freqStr }]);
  }

  /* ------------ REMOVE LINK ------------ */
  function removeLink(id) {
    setLinks((prev) => prev.filter((l) => l.id !== id));
    setSelectedLink(null);
  }

  /* ------------ SHOW FRESNEL ------------ */
  function onLinkClick(l) {
    setSelectedLink(l.id);

    const a = towers.find((t) => t.id === l.aId);
    const b = towers.find((t) => t.id === l.bId);
    if (!a || !b) return;

    const freqHz = parseFreqHz(l.freqStr);
    const fresnelInfo = computeSimpleFresnel(a, b, freqHz);

    const rMidScaled = fresnelInfo.rMidMeters * SCALE_FACTOR;

    const pts = generateFresnelEllipse(
      a.lat,
      a.lng,
      b.lat,
      b.lng,
      rMidScaled,
      180
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

  return (
    <div className="layout-container">
      <div className="map-section">
        <MapContainer center={[22.5, 77.5]} zoom={6} className="map-element">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          <AddTowerOnClick onAdd={addTower} />

          {towers.map((t) => (
            <Marker
              key={t.id}
              position={[t.lat, t.lng]}
              icon={towerIcon}
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
                      event.originalEvent.preventDefault();
                      event.originalEvent.stopPropagation();
                      onLinkClick(l);
                    },
                  }}
                >
                  <Tooltip>
                    Distance: {(distanceMeters(a, b) / 1000).toFixed(2)} km
                    <br />
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
                      click: (event) => {
                        event.originalEvent.preventDefault();
                        event.originalEvent.stopPropagation();
                      },
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

      {/* SIDEBAR */}
      <aside className="sidebar">
        <h2>RF Link Planner</h2>
        <p>{message}</p>

        <h3>Towers</h3>
        {towers.map((t) => (
          <div key={t.id} className="tower-card">
            <div className="tower-row">
              <div>
                <strong>Tower {t.id}</strong>
                <div className="coords">
                  {t.lat.toFixed(4)}, {t.lng.toFixed(4)}
                </div>
              </div>

              <div>
                <input
                  value={t.freqStr}
                  onChange={(e) =>
                    updateTower(t.id, { freqStr: e.target.value })
                  }
                  className="freq-input"
                />

                <div className="tower-buttons">
                  <button onClick={() => setSelectedTower(t.id)}>
                    {selectedTower === t.id ? "Selected" : "Select"}
                  </button>

                  <button
                    onClick={() => removeTower(t.id)}
                    className="remove-btn"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

        <h3>Links</h3>
        {links.map((l) => {
          const a = towers.find((t) => t.id === l.aId);
          const b = towers.find((t) => t.id === l.bId);
          const dist = a && b ? (distanceMeters(a, b) / 1000).toFixed(2) : "-";

          return (
            <div key={l.id} className="link-card">
              <div className="link-row">
                <div>
                  <strong>Link {l.id}</strong>
                  <div className="coords">
                    {l.aId} ↔ {l.bId} · {dist} km · {l.freqStr}
                  </div>
                </div>

                <div className="link-buttons">
                  <button onClick={() => onLinkClick(l)}>Show Fresnel</button>
                  <button
                    onClick={() => removeLink(l.id)}
                    className="remove-btn"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        <ol className="steps">
          <h4>STEP 1</h4>
          <h4>Click on the map to add a tower.</h4>
          <h4>STEP 2</h4>
          <h4>
            Select two towers with same frequency. NOTE: TOWERS WITH DIFFERENT
            FREQUENCY CAN'T BE LINKED
          </h4>
          <h4>STEP 3</h4>
          <h4>Click “Show Fresnel” to visualize the zone.</h4>
        </ol>
      </aside>
    </div>
  );
}
