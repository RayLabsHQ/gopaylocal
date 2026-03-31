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

// ── Precomputed lookup tables ────────────────────────────────────────

const COLS = 130;
const ROWS = 72;
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

  const animate = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { frameRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext("2d");
    if (!ctx) { frameRef.current = requestAnimationFrame(animate); return; }

    if (!lastRef.current) lastRef.current = t;
    const dt = Math.min((t - lastRef.current) / 1000, 0.1);
    lastRef.current = t;

    // Physics
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

    // Measure once / on resize
    const sz = sizeRef.current;
    if (!sz.fontSize) {
      const fs = parseFloat(getComputedStyle(canvas).fontSize) || 6;
      ctx.font = `${fs}px JetBrains Mono,monospace`;
      const cw = ctx.measureText("#").width || fs * 0.6;
      const ch = fs * 1.15;
      sz.fontSize = fs; sz.charW = cw; sz.charH = ch;
      sz.w = Math.ceil(COLS * cw);
      sz.h = Math.ceil(ROWS * ch);
      canvas.width = sz.w;
      canvas.height = sz.h;
    }

    // Compute
    computeFrame(angleRef.current, tiltRef.current, bmpRef.current, sz.charW, sz.charH);

    // Draw
    ctx.clearRect(0, 0, sz.w, sz.h);

    // Semi-transparent background circle — glassmorphism effect
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colorsRef.current.bg;
    ctx.beginPath();
    ctx.ellipse(sz.w / 2, sz.h / 2, sz.w / 2, sz.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.textBaseline = "top";
    ctx.font = `${sz.fontSize}px JetBrains Mono,monospace`;

    // Smooth mouse + trail update
    const rawMouse = !dragRef.current.active ? mouseRef.current : null;
    const sm = smoothMouseRef.current;
    const trail = trailRef.current;

    if (rawMouse) {
      if (sm) {
        // Lerp toward actual mouse position
        sm.x += (rawMouse.x - sm.x) * 0.3;
        sm.y += (rawMouse.y - sm.y) * 0.3;
      } else {
        smoothMouseRef.current = { x: rawMouse.x, y: rawMouse.y };
      }
      // Push current smooth position to front of trail
      const cur = smoothMouseRef.current!;
      trail.unshift({ x: cur.x, y: cur.y });
      if (trail.length > TRAIL_LEN) trail.length = TRAIL_LEN;
    } else {
      // Fade trail out by removing tail
      smoothMouseRef.current = null;
      if (trail.length > 0) trail.pop();
    }

    const { land: landColor, earth: earthColor } = colorsRef.current;
    const total = COLS * ROWS;
    const trailLen = trail.length;

    for (let i = 0; i < total; i++) {
      if (!cellActive[i]) continue;

      let px = cellBx[i], py = cellBy[i];

      // Accumulate repel from each trail point (head = strongest, tail = weakest)
      if (trailLen > 0) {
        const cx = px + sz.charW * 0.5;
        const cy = py + sz.charH * 0.5;
        let fx = 0, fy = 0;
        for (let t = 0; t < trailLen; t++) {
          const strength = (1 - t / TRAIL_LEN); // 1.0 → 0.0
          const radius = REPEL_R * (0.5 + strength * 0.5); // shrinks along trail
          const mx = cx - trail[t].x;
          const my = cy - trail[t].y;
          const d2 = mx * mx + my * my;
          if (d2 < radius * radius && d2 > 0) {
            const d = Math.sqrt(d2);
            const f = (1 - d / radius) * REPEL_STR * strength;
            fx += (mx / d) * f;
            fy += (my / d) * f;
          }
        }
        px += fx;
        py += fy;
      }

      if (cellLand[i]) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = landColor;
      } else {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = earthColor;
      }

      ctx.fillText(cellLand[i] ? "#" : ".", px, py);
    }

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
          fontSize: "6px",
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
