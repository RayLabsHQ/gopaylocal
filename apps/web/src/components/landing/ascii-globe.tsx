import { useRef, useEffect, useCallback } from "react";

// ── Types ────────────────────────────────────────────────────────────

type Ring = [number, number][];
type LandPolygon = {
  rings: Ring[];
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
};

// ── GeoJSON parsing ──────────────────────────────────────────────────

function parseLand(geo: any): LandPolygon[] {
  const polys: LandPolygon[] = [];
  for (const feat of geo.features) {
    const geom = feat.geometry;
    const all: Ring[][] =
      geom.type === "Polygon" ? [geom.coordinates]
      : geom.type === "MultiPolygon" ? geom.coordinates : [];
    for (const polyRings of all) {
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const ring of polyRings)
        for (const [lon, lat] of ring) {
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        }
      polys.push({ rings: polyRings, minLat, maxLat, minLon, maxLon });
    }
  }
  return polys;
}

function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function isLand(lat: number, lon: number, polys: LandPolygon[]): boolean {
  for (const p of polys) {
    if (lat < p.minLat || lat > p.maxLat || lon < p.minLon || lon > p.maxLon) continue;
    if (!pointInRing(lat, lon, p.rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < p.rings.length; h++)
      if (pointInRing(lat, lon, p.rings[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

// ── Bitmap ───────────────────────────────────────────────────────────

const MAP_W = 720;
const MAP_H = 360;

function bakeBitmap(polys: LandPolygon[]): Uint8Array {
  const bmp = new Uint8Array(MAP_W * MAP_H);
  for (let row = 0; row < MAP_H; row++) {
    const lat = 90 - row * (180 / MAP_H);
    for (let col = 0; col < MAP_W; col++) {
      const lon = -180 + col * (360 / MAP_W);
      if (isLand(lat, lon, polys)) bmp[row * MAP_W + col] = 1;
    }
  }
  return bmp;
}

function bmpLookup(lat: number, lon: number, bmp: Uint8Array): boolean {
  const row = Math.floor((90 - lat) / (180 / MAP_H));
  const col = Math.floor((lon + 180) / (360 / MAP_W));
  if (row < 0 || row >= MAP_H || col < 0 || col >= MAP_W) return false;
  return bmp[row * MAP_W + col] === 1;
}

// ── Globe grid computation ───────────────────────────────────────────

const LAND = "#";
const EARTH = ".";
const COLS = 80;
const ROWS = 40;

interface Cell {
  ch: string;
  isLand: boolean;
  // base grid position in pixels
  bx: number;
  by: number;
}

function computeGrid(
  rotY: number,
  tilt: number,
  bmp: Uint8Array | null,
  charW: number,
  charH: number,
): Cell[] {
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  const cells: Cell[] = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = (2 * col - COLS + 1) / COLS;
      const y = (2 * row - ROWS + 1) / ROWS;
      const bx = col * charW;
      const by = row * charH;

      if (x * x + y * y > 1) continue;

      const z = Math.sqrt(1 - x * x - y * y);
      const rx = x * cosR + z * sinR;
      const rz = -x * sinR + z * cosR;
      const fy = y * cosT - rz * sinT;
      const fz = y * sinT + rz * cosT;

      const lat = Math.asin(Math.max(-1, Math.min(1, -fy))) * (180 / Math.PI);
      const lon = Math.atan2(rx, fz) * (180 / Math.PI);

      let land: boolean;
      if (bmp) {
        land = bmpLookup(lat, lon, bmp);
      } else {
        land = fallbackIsLand(lat, lon);
      }

      cells.push({ ch: land ? LAND : EARTH, isLand: land, bx, by });
    }
  }
  return cells;
}

// ── Fallback scanline map ────────────────────────────────────────────

const FALLBACK: Record<number, number[]> = {
  70: [-55,-22, 18,32, 33,180, -170,-145, -140,-120, -100,-80],
  66: [-54,-30, 14,30, 32,175, -168,-140, -140,-60],
  62: [-52,-40, 5,32, 33,165, -167,-140, -140,-55],
  58: [-10,-5, 5,32, 33,162, -165,-135, -135,-52],
  54: [-10,-1, 6,22, 28,160, -132,-55],
  50: [-5,2, 3,42, 42,155, -128,-53],
  46: [-4,7, 7,42, 42,145, -125,-52],
  42: [-9,3, 10,16, 18,44, 44,145, 130,145, -124,-70],
  38: [-10,0, 12,17, 20,44, 44,140, 130,141, -124,-75],
  34: [-8,-1, 3,11, 24,72, 72,136, -120,-76],
  30: [-10,-5, -2,35, 35,72, 68,78, 80,122, -115,-80],
  26: [-16,33, 34,56, 66,90, 90,120, -108,-80],
  22: [-17,33, 36,58, 69,90, 93,115, -108,-87],
  18: [-17,25, 42,57, 73,85, 95,108, -105,-87],
  14: [-17,2, 33,48, 74,80, 98,108, -90,-87],
  10: [-15,10, 42,51, 76,80, 98,107, -85,-79, -75,-62],
  6: [-11,12, 80,82, 99,106, -77,-55],
  2: [5,32, 96,105, 109,118, -80,-50],
  "-2": [12,41, 100,105, 110,117, 132,141, -81,-45],
  "-8": [13,40, 110,130, 140,148, -79,-35],
  "-14": [17,41, 44,50, 124,137, -76,-39],
  "-20": [25,40, 44,48, 119,149, -70,-40],
  "-26": [17,35, 113,153, -70,-48],
  "-32": [18,29, 115,152, -72,-52],
  "-38": [140,150, 175,178, -74,-58],
  "-44": [145,148, 168,172, -75,-65],
  "-50": [-76,-69],
};

function fallbackIsLand(lat: number, lon: number): boolean {
  let best = 0, bestDist = 999;
  for (const k of Object.keys(FALLBACK)) {
    const d = Math.abs(Number(k) - lat);
    if (d < bestDist) { bestDist = d; best = Number(k); }
  }
  if (bestDist > 5) return false;
  const ranges = FALLBACK[best];
  if (!ranges) return false;
  for (let i = 0; i < ranges.length; i += 2)
    if (lon >= ranges[i] && lon <= ranges[i + 1]) return true;
  return false;
}

// ── Canvas-based component ───────────────────────────────────────────

const REPEL_RADIUS = 60; // px
const REPEL_STRENGTH = 18; // max displacement in px

export function AsciiGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const angleRef = useRef(0);
  const bmpRef = useRef<Uint8Array | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const lastRef = useRef(0);

  // Load GeoJSON and bake bitmap
  useEffect(() => {
    fetch("/globe.json")
      .then((r) => r.json())
      .then((geo) => {
        bmpRef.current = bakeBitmap(parseLand(geo));
      })
      .catch(() => {});
  }, []);

  const animate = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { frameRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!lastRef.current) lastRef.current = t;
    const dt = Math.min((t - lastRef.current) / 1000, 0.1);
    lastRef.current = t;

    angleRef.current += dt * 0.12;
    const tilt = -0.3 + Math.sin(t * 0.00025) * 0.1;

    // Measure char size
    const style = getComputedStyle(canvas);
    const fontSize = parseFloat(style.fontSize) || 10;
    ctx.font = `${fontSize}px JetBrains Mono, monospace`;
    const charW = ctx.measureText("#").width || fontSize * 0.6;
    const charH = fontSize * 1.15;

    // Size canvas to fit grid
    const w = Math.ceil(COLS * charW);
    const h = Math.ceil(ROWS * charH);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // Compute globe
    const cells = computeGrid(angleRef.current, tilt, bmpRef.current, charW, charH);

    // Clear
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = "top";
    ctx.font = `${fontSize}px JetBrains Mono, monospace`;

    const mouse = mouseRef.current;

    // Get CSS custom property colors
    const rootStyle = getComputedStyle(document.documentElement);
    const landColor = rootStyle.getPropertyValue("--text-1").trim() || "#0D0D0D";
    const earthColor = rootStyle.getPropertyValue("--text-3").trim() || "#B0B0B0";

    for (const cell of cells) {
      let dx = 0, dy = 0;

      if (mouse) {
        const distX = cell.bx + charW / 2 - mouse.x;
        const distY = cell.by + charH / 2 - mouse.y;
        const dist = Math.sqrt(distX * distX + distY * distY);
        if (dist < REPEL_RADIUS && dist > 0) {
          const force = (1 - dist / REPEL_RADIUS) * REPEL_STRENGTH;
          dx = (distX / dist) * force;
          dy = (distY / dist) * force;
        }
      }

      if (cell.isLand) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = landColor;
      } else {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = earthColor;
      }

      ctx.fillText(cell.ch, cell.bx + dx, cell.by + dy);
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
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="select-none"
      style={{ fontSize: "10px" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      aria-hidden="true"
    />
  );
}
