import { useRef, useEffect, useCallback } from "react";

// ── Types ────────────────────────────────────────────────────────────

type Ring = [number, number][];
type LandPoly = {
  rings: Ring[];
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
};

// ── GeoJSON → bitmap (runs once on load) ─────────────────────────────

function parseLand(geo: any): LandPoly[] {
  const polys: LandPoly[] = [];
  for (const feat of geo.features) {
    const g = feat.geometry;
    const all: Ring[][] =
      g.type === "Polygon" ? [g.coordinates]
      : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const rings of all) {
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const ring of rings)
        for (const [lon, lat] of ring) {
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        }
      polys.push({ rings, minLat, maxLat, minLon, maxLon });
    }
  }
  return polys;
}

function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0])
      inside = !inside;
  }
  return inside;
}

const BMP_W = 720;
const BMP_H = 360;
const LAT_STEP = 180 / BMP_H;
const LON_STEP = 360 / BMP_W;

function bakeBitmap(polys: LandPoly[]): Uint8Array {
  const bmp = new Uint8Array(BMP_W * BMP_H);
  for (let row = 0; row < BMP_H; row++) {
    const lat = 90 - row * LAT_STEP;
    for (let col = 0; col < BMP_W; col++) {
      const lon = -180 + col * LON_STEP;
      for (const p of polys) {
        if (lat < p.minLat || lat > p.maxLat || lon < p.minLon || lon > p.maxLon) continue;
        if (!pointInRing(lat, lon, p.rings[0])) continue;
        let hole = false;
        for (let h = 1; h < p.rings.length; h++)
          if (pointInRing(lat, lon, p.rings[h])) { hole = true; break; }
        if (!hole) { bmp[row * BMP_W + col] = 1; break; }
      }
    }
  }
  return bmp;
}

// ── Arc data ─────────────────────────────────────────────────────────

interface Arc {
  startLat: number; startLon: number;
  endLat: number; endLon: number;
  speed: number;
}

const ARCS: Arc[] = [
  { startLat: 28.6, startLon: 77.2, endLat: 51.5, endLon: -0.1, speed: 3 },
  { startLat: 40.7, startLon: -74.0, endLat: 48.9, endLon: 2.35, speed: 2.5 },
  { startLat: -33.9, startLon: 151.2, endLat: 35.7, endLon: 139.7, speed: 2.8 },
  { startLat: 1.35, startLon: 103.8, endLat: -34.6, endLon: -58.4, speed: 3.5 },
  { startLat: 37.6, startLon: 127.0, endLat: 34.1, endLon: -118.2, speed: 3.2 },
  { startLat: -22.9, startLon: -43.2, endLat: 22.3, endLon: 114.2, speed: 4 },
  { startLat: 52.5, startLon: 13.4, endLat: -1.3, endLon: 36.8, speed: 2.6 },
  { startLat: 55.8, startLon: 37.6, endLat: 31.2, endLon: 121.5, speed: 3.1 },
  { startLat: 14.6, startLon: 121.0, endLat: 49.3, endLon: -123.1, speed: 3.4 },
  { startLat: -8.8, startLon: 13.3, endLat: -15.8, endLon: -47.9, speed: 2.9 },
  { startLat: 41.9, startLon: 12.5, endLat: 39.9, endLon: 116.4, speed: 3.6 },
  { startLat: -6.2, startLon: 106.8, endLat: 52.4, endLon: 4.9, speed: 3.3 },
];

const RAD = Math.PI / 180;

// Convert lat/lon to 3D unit sphere point
function latLonToXYZ(lat: number, lon: number): [number, number, number] {
  const phi = lat * RAD, lam = lon * RAD;
  const cp = Math.cos(phi);
  return [cp * Math.sin(lam), -Math.sin(phi), cp * Math.cos(lam)];
}

// Slerp between two unit vectors — great circle interpolation
function slerp(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const omega = Math.acos(dot);
  if (omega < 0.001) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const sinO = Math.sin(omega);
  const sa = Math.sin((1 - t) * omega) / sinO;
  const sb = Math.sin(t * omega) / sinO;
  return [sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]];
}

// Lift a point off the sphere surface for arc height
function liftPoint(p: [number, number, number], altitude: number): [number, number, number] {
  const scale = 1 + altitude;
  return [p[0] * scale, p[1] * scale, p[2] * scale];
}

// Project a 3D point to canvas coords, returns null if behind globe
function project3D(
  sx: number, sy: number, sz: number,
  rotY: number, tilt: number,
  w: number, h: number,
): { x: number; y: number; z: number } | null {
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
  const rx = sx * cosR - sz * sinR;
  const rz = sx * sinR + sz * cosR;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const fy = sy * cosT - rz * sinT;
  const fz = sy * sinT + rz * cosT;
  if (fz < -0.6) return null;
  return { x: (rx + 1) / 2 * w, y: (fy + 1) / 2 * h, z: fz };
}

// ── Precomputed lookup tables ────────────────────────────────────────

const COLS = 140;
const ROWS = 78;
const DEG = 180 / Math.PI;
const REPEL_R = 20;
const REPEL_STR = 8;

// Precompute grid coordinates (never changes)
const gridX = new Float32Array(COLS * ROWS);
const gridY = new Float32Array(COLS * ROWS);
const gridR2 = new Float32Array(COLS * ROWS); // x²+y², -1 if outside
for (let r = 0; r < ROWS; r++) {
  const y = (2 * r - ROWS + 1) / ROWS;
  for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    const x = (2 * c - COLS + 1) / COLS;
    const d = x * x + y * y;
    gridX[i] = x;
    gridY[i] = y;
    gridR2[i] = d <= 1 ? d : -1;
  }
}

// Char codes
const LAND_CODE = "#".charCodeAt(0);
const EARTH_CODE = ".".charCodeAt(0);

// ── Render to typed arrays (zero GC per frame) ──────────────────────

// Reusable buffers
const cellBx = new Float32Array(COLS * ROWS);
const cellBy = new Float32Array(COLS * ROWS);
const cellLand = new Uint8Array(COLS * ROWS);
const cellActive = new Uint8Array(COLS * ROWS); // 1 = inside sphere

function computeFrame(
  rotY: number, tilt: number, bmp: Uint8Array | null,
  charW: number, charH: number,
): number {
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
  let count = 0;

  for (let r = 0; r < ROWS; r++) {
    const byBase = r * charH;
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (gridR2[i] < 0) { cellActive[i] = 0; continue; }

      const x = gridX[i], y = gridY[i];
      const z = Math.sqrt(1 - gridR2[i]);
      const rx = x * cosR + z * sinR;
      const rz = -x * sinR + z * cosR;
      const fy = y * cosT - rz * sinT;
      const fz = y * sinT + rz * cosT;

      const lat = Math.asin(fy > 1 ? 1 : fy < -1 ? -1 : -fy) * DEG;
      const lon = Math.atan2(rx, fz) * DEG;

      let land = 0;
      if (bmp) {
        const br = ((90 - lat) / LAT_STEP) | 0;
        const bc = ((lon + 180) / LON_STEP) | 0;
        if (br >= 0 && br < BMP_H && bc >= 0 && bc < BMP_W)
          land = bmp[br * BMP_W + bc];
      }

      cellBx[i] = c * charW;
      cellBy[i] = byBase;
      cellLand[i] = land;
      cellActive[i] = 1;
      count++;
    }
  }
  return count;
}

// ── Component (desktop only) ─────────────────────────────────────────

export function AsciiGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const angleRef = useRef(0);
  const tiltRef = useRef(-0.3);
  const velRef = useRef({ angle: 0, tilt: 0 });
  const bmpRef = useRef<Uint8Array | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  // Trail: array of past mouse positions, [0] = newest
  const TRAIL_LEN = 8;
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const smoothMouseRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0 });
  const lastRef = useRef(0);
  // Cache colors so we don't read getComputedStyle every frame
  const sizeRef = useRef({ w: 0, h: 0, charW: 0, charH: 0, fontSize: 0 });

  // Load GeoJSON + bake bitmap in background
  useEffect(() => {
    fetch("/globe.json")
      .then(r => r.json())
      .then(geo => { bmpRef.current = bakeBitmap(parseLand(geo)); })
      .catch(() => {});
  }, []);

  // Fixed globe colors — always dark, never changes with theme
  const colorsRef = useRef({
    land: "#F1F5F9",
    earth: "#64748B",
    bg: "#0A0A0A",
  });

  const frameSkipRef = useRef(0);

  const animate = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { frameRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext("2d");
    if (!ctx) { frameRef.current = requestAnimationFrame(animate); return; }

    if (!lastRef.current) lastRef.current = t;
    const dt = Math.min((t - lastRef.current) / 1000, 0.1);
    lastRef.current = t;

    // Physics runs every frame for smooth drag
    const vel = velRef.current;
    if (dragRef.current.active) {
      // velocity set by mousemove
    } else {
      vel.angle *= 0.95;
      vel.tilt *= 0.95;
      if (Math.abs(vel.angle) < 0.001 && Math.abs(vel.tilt) < 0.001) {
        vel.angle = 0;
        vel.tilt = 0;
        angleRef.current += dt * 0.12;
      } else {
        angleRef.current += vel.angle;
        tiltRef.current = Math.max(-1.2, Math.min(1.2, tiltRef.current + vel.tilt));
      }
    }

    // Render at ~30fps (skip every other frame) unless dragging
    frameSkipRef.current++;
    if (!dragRef.current.active && frameSkipRef.current % 2 !== 0) {
      frameRef.current = requestAnimationFrame(animate);
      return;
    }

    // Measure once
    const sz = sizeRef.current;
    if (!sz.fontSize) {
      const fs = parseFloat(getComputedStyle(canvas).fontSize) || 4.5;
      ctx.font = `${fs}px JetBrains Mono,monospace`;
      const cw = ctx.measureText("#").width || fs * 0.6;
      const ch = fs * 1.15;
      sz.fontSize = fs; sz.charW = cw; sz.charH = ch;
      sz.w = Math.ceil(COLS * cw);
      sz.h = Math.ceil(ROWS * ch);
      canvas.width = sz.w;
      canvas.height = sz.h;
    }

    // Compute grid
    computeFrame(angleRef.current, tiltRef.current, bmpRef.current, sz.charW, sz.charH);

    // Draw
    ctx.clearRect(0, 0, sz.w, sz.h);

    // Background circle
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colorsRef.current.bg;
    ctx.beginPath();
    ctx.ellipse(sz.w / 2, sz.h / 2, sz.w / 2, sz.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.textBaseline = "top";
    ctx.font = `${sz.fontSize}px JetBrains Mono,monospace`;

    // Mouse trail update
    const rawMouse = !dragRef.current.active ? mouseRef.current : null;
    const sm = smoothMouseRef.current;
    const trail = trailRef.current;
    if (rawMouse) {
      if (sm) { sm.x += (rawMouse.x - sm.x) * 0.3; sm.y += (rawMouse.y - sm.y) * 0.3; }
      else { smoothMouseRef.current = { x: rawMouse.x, y: rawMouse.y }; }
      const cur = smoothMouseRef.current!;
      trail.unshift({ x: cur.x, y: cur.y });
      if (trail.length > TRAIL_LEN) trail.length = TRAIL_LEN;
    } else {
      smoothMouseRef.current = null;
      if (trail.length > 0) trail.pop();
    }

    const { land: landColor, earth: earthColor } = colorsRef.current;
    const total = COLS * ROWS;
    const trailLen = trail.length;
    const hasTrail = trailLen > 0;
    const halfCW = sz.charW * 0.5;
    const halfCH = sz.charH * 0.5;

    // ── Pass 1: Earth dots (batched, no shadow) ──
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = earthColor;
    for (let i = 0; i < total; i++) {
      if (!cellActive[i] || cellLand[i]) continue;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) {
        const cx = px + halfCW, cy = py + halfCH;
        let fx = 0, fy = 0;
        for (let t = 0; t < trailLen; t++) {
          const mx = cx - trail[t].x, my = cy - trail[t].y;
          const d2 = mx * mx + my * my;
          if (d2 < REPEL_R * REPEL_R && d2 > 0) {
            const strength = 1 - t / TRAIL_LEN;
            const radius = REPEL_R * (0.5 + strength * 0.5);
            if (d2 < radius * radius) {
              const d = Math.sqrt(d2);
              const f = (1 - d / radius) * REPEL_STR * strength;
              fx += (mx / d) * f; fy += (my / d) * f;
            }
          }
        }
        px += fx; py += fy;
      }
      ctx.fillText(".", px, py);
    }

    // ── Pass 2: Land chars (no rim glow) ──
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = landColor;
    for (let i = 0; i < total; i++) {
      if (!cellActive[i] || !cellLand[i] || gridR2[i] > 0.9) continue;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) {
        const cx = px + halfCW, cy = py + halfCH;
        let fx = 0, fy = 0;
        for (let t = 0; t < trailLen; t++) {
          const mx = cx - trail[t].x, my = cy - trail[t].y;
          const d2 = mx * mx + my * my;
          if (d2 < REPEL_R * REPEL_R && d2 > 0) {
            const strength = 1 - t / TRAIL_LEN;
            const radius = REPEL_R * (0.5 + strength * 0.5);
            if (d2 < radius * radius) {
              const d = Math.sqrt(d2);
              const f = (1 - d / radius) * REPEL_STR * strength;
              fx += (mx / d) * f; fy += (my / d) * f;
            }
          }
        }
        px += fx; py += fy;
      }
      ctx.fillText("#", px, py);
    }

    // ── Pass 3: Land rim glow (few cells, expensive shadow) ──
    ctx.shadowColor = "#ffffff";
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < total; i++) {
      if (!cellActive[i] || !cellLand[i] || gridR2[i] <= 0.9) continue;
      const rim = gridR2[i];
      ctx.shadowBlur = 40 * ((rim - 0.9) / 0.1);
      ctx.globalAlpha = 1;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) {
        const cx = px + halfCW, cy = py + halfCH;
        let fx = 0, fy = 0;
        for (let t = 0; t < trailLen; t++) {
          const mx = cx - trail[t].x, my = cy - trail[t].y;
          const d2 = mx * mx + my * my;
          if (d2 < REPEL_R * REPEL_R && d2 > 0) {
            const strength = 1 - t / TRAIL_LEN;
            const radius = REPEL_R * (0.5 + strength * 0.5);
            if (d2 < radius * radius) {
              const d = Math.sqrt(d2);
              const f = (1 - d / radius) * REPEL_STR * strength;
              fx += (mx / d) * f; fy += (my / d) * f;
            }
          }
        }
        px += fx; py += fy;
      }
      ctx.fillText("#", px, py);
    }
    ctx.shadowBlur = 0;

    // ── Draw arcs (great-circle, white glow, tapered) ──
    const rotY = angleRef.current;
    const currentTilt = tiltRef.current;
    const ARC_STEPS = 60;

    ctx.shadowColor = "#ffffff";
    ctx.lineCap = "round";

    for (const arc of ARCS) {
      const a = latLonToXYZ(arc.startLat, arc.startLon);
      const b = latLonToXYZ(arc.endLat, arc.endLon);

      // Compute great-circle distance for arc height
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const arcAngle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const maxAlt = arcAngle * 0.4; // tall arcs that fly above the globe

      // Animated progress
      const cycle = (t / 1000) / arc.speed;
      const head = cycle % 1;
      const tailLen = 0.4;
      const tail = Math.max(0, head - tailLen);

      // Project all visible points along the arc
      const points: { x: number; y: number; t: number; fade: number }[] = [];
      for (let s = 0; s <= ARC_STEPS; s++) {
        const st = s / ARC_STEPS;
        const p = slerp(a, b, st);
        const alt = maxAlt * 4 * st * (1 - st);
        const lifted = liftPoint(p, alt);
        const proj = project3D(lifted[0], lifted[1], lifted[2], rotY, currentTilt, sz.w, sz.h);
        if (!proj) continue;
        // Smooth fade: 1 when facing viewer, 0 when at edge/behind
        const fade = Math.max(0, Math.min(1, (proj.z + 0.3) / 0.5));
        points.push({ x: proj.x, y: proj.y, t: st, fade });
      }

      if (points.length < 2) continue;

      const stepSize = 1 / ARC_STEPS;

      // ── Full arc path: thin dim line with edge fade ──
      ctx.shadowBlur = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 0.5;
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1], p1 = points[i];
        if (p1.t - p0.t > stepSize * 2.5) continue;
        const fade = Math.min(p0.fade, p1.fade);
        ctx.globalAlpha = 0.15 * fade;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      // ── Bright animated trail with edge fade ──
      ctx.shadowBlur = 6;
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1], p1 = points[i];
        if (p1.t - p0.t > stepSize * 2.5) continue;

        const mid = (p0.t + p1.t) / 2;
        if (mid < tail || mid > head) continue;

        const fade = Math.min(p0.fade, p1.fade);
        const progress = (mid - tail) / tailLen;
        const width = 2.5 * (1 - progress) + 0.5;
        const alpha = (0.3 + 0.7 * progress) * fade;

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      // Head dot — bright white glow
      if (points.length > 0) {
        const headPt = points.find(p => p.t >= head) || points[points.length - 1];
        ctx.shadowBlur = 12;
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(headPt.x, headPt.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Endpoint dots — red glow with edge fade
      ctx.shadowColor = "#E42313";
      ctx.shadowBlur = 8;
      for (const [lat, lon] of [[arc.startLat, arc.startLon], [arc.endLat, arc.endLon]] as [number, number][]) {
        const xyz = latLonToXYZ(lat, lon);
        const proj = project3D(xyz[0], xyz[1], xyz[2], rotY, currentTilt, sz.w, sz.h);
        if (!proj) continue;
        const dotFade = Math.max(0, Math.min(1, (proj.z + 0.3) / 0.5));
        ctx.globalAlpha = 0.8 * dotFade;
        ctx.fillStyle = "#E42313";
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowColor = "#ffffff";
    }

    ctx.shadowBlur = 0;

    ctx.globalAlpha = 1;
    frameRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [animate]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      const ad = -dx * 0.008, td = dy * 0.008;
      angleRef.current += ad;
      tiltRef.current = Math.max(-1.2, Math.min(1.2, tiltRef.current + td));
      velRef.current = { angle: ad, tilt: td };
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
    } else {
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    mouseRef.current = null;
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current.active = false; }, []);
  const handleMouseLeave = useCallback(() => {
    dragRef.current.active = false;
    mouseRef.current = null;
  }, []);

  return (
    <div style={{ perspective: "800px" }}>
      <canvas
        ref={canvasRef}
        className="select-none"
        style={{
          fontSize: "5.5px",
          transform: "rotateX(15deg) rotateY(-5deg)",
          transformOrigin: "center center",
        }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        aria-hidden="true"
      />
    </div>
  );
}
