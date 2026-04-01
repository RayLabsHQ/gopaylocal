import { useRef, useEffect, useCallback } from "react";

// ── GeoJSON → bitmap (runs once on load) ─────────────────────────────

type Ring = [number, number][];

function parseLand(geo: any) {
  const polys: { rings: Ring[]; minLat: number; maxLat: number; minLon: number; maxLon: number }[] = [];
  for (const feat of geo.features) {
    const g = feat.geometry;
    const all: Ring[][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
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
    if ((yi > lat) !== (yj > lat) && lon < ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0])
      inside = !inside;
  }
  return inside;
}

const BMP_W = 720, BMP_H = 360;
const LAT_STEP = 180 / BMP_H, LON_STEP = 360 / BMP_W;

function bakeBitmap(polys: ReturnType<typeof parseLand>): Uint8Array {
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

// ── Arc definitions ──────────────────────────────────────────────────

const ARCS = [
  { sLat: 28.6, sLon: 77.2, eLat: 51.5, eLon: -0.1, spd: 3 },
  { sLat: 40.7, sLon: -74.0, eLat: 48.9, eLon: 2.35, spd: 2.5 },
  { sLat: -33.9, sLon: 151.2, eLat: 35.7, eLon: 139.7, spd: 2.8 },
  { sLat: 1.35, sLon: 103.8, eLat: -34.6, eLon: -58.4, spd: 3.5 },
  { sLat: 37.6, sLon: 127.0, eLat: 34.1, eLon: -118.2, spd: 3.2 },
  { sLat: -22.9, sLon: -43.2, eLat: 22.3, eLon: 114.2, spd: 4 },
  { sLat: 52.5, sLon: 13.4, eLat: -1.3, eLon: 36.8, spd: 2.6 },
  { sLat: 55.8, sLon: 37.6, eLat: 31.2, eLon: 121.5, spd: 3.1 },
  { sLat: 14.6, sLon: 121.0, eLat: 49.3, eLon: -123.1, spd: 3.4 },
  { sLat: -8.8, sLon: 13.3, eLat: -15.8, eLon: -47.9, spd: 2.9 },
  { sLat: 41.9, sLon: 12.5, eLat: 39.9, eLon: 116.4, spd: 3.6 },
  { sLat: -6.2, sLon: 106.8, eLat: 52.4, eLon: 4.9, spd: 3.3 },
] as const;

// Precompute arc endpoint XYZ (never changes)
const RAD = Math.PI / 180;
function toXYZ(lat: number, lon: number): [number, number, number] {
  const p = lat * RAD, l = lon * RAD, cp = Math.cos(p);
  return [cp * Math.sin(l), -Math.sin(p), cp * Math.cos(l)];
}
const arcXYZ = ARCS.map(a => ({
  a: toXYZ(a.sLat, a.sLon), b: toXYZ(a.eLat, a.eLon),
  aS: toXYZ(a.sLat, a.sLon), bS: toXYZ(a.eLat, a.eLon), // surface endpoints for dots
  spd: a.spd,
  // precompute angle + max altitude
  angle: 0, maxAlt: 0,
}));
for (const a of arcXYZ) {
  const d = a.a[0] * a.b[0] + a.a[1] * a.b[1] + a.a[2] * a.b[2];
  a.angle = Math.acos(Math.max(-1, Math.min(1, d)));
  a.maxAlt = a.angle * 0.4;
}

// Slerp + project helpers
function slerp(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const om = Math.acos(dot);
  if (om < 0.001) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const s = Math.sin(om), sa = Math.sin((1 - t) * om) / s, sb = Math.sin(t * om) / s;
  return [sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]];
}

function project(sx: number, sy: number, sz: number, cosR: number, sinR: number, cosT: number, sinT: number, w: number, h: number) {
  const rx = sx * cosR - sz * sinR;
  const rz = sx * sinR + sz * cosR;
  const fy = sy * cosT - rz * sinT;
  const fz = sy * sinT + rz * cosT;
  if (fz < -0.6) return null;
  return { x: (rx + 1) * 0.5 * w, y: (fy + 1) * 0.5 * h, z: fz };
}

// ── Grid constants & precomputed tables ──────────────────────────────

const COLS = 140, ROWS = 78;
const DEG = 180 / Math.PI;
const REPEL_R = 20, REPEL_R2 = REPEL_R * REPEL_R, REPEL_STR = 8;
const TOTAL = COLS * ROWS;
const TAIL_LEN = 0.4, ARC_STEPS = 50, ARC_STEP_INV = 1 / ARC_STEPS;

const gridX = new Float32Array(TOTAL);
const gridY = new Float32Array(TOTAL);
const gridR2 = new Float32Array(TOTAL);
for (let r = 0; r < ROWS; r++) {
  const y = (2 * r - ROWS + 1) / ROWS;
  for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    const x = (2 * c - COLS + 1) / COLS;
    const d = x * x + y * y;
    gridX[i] = x; gridY[i] = y; gridR2[i] = d <= 1 ? d : -1;
  }
}

const cellBx = new Float32Array(TOTAL);
const cellBy = new Float32Array(TOTAL);
const cellLand = new Uint8Array(TOTAL);
const cellActive = new Uint8Array(TOTAL);

function computeGrid(rotY: number, tilt: number, bmp: Uint8Array | null, charW: number, charH: number) {
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
  for (let r = 0; r < ROWS; r++) {
    const byBase = r * charH;
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (gridR2[i] < 0) { cellActive[i] = 0; continue; }
      const x = gridX[i], y = gridY[i], z = Math.sqrt(1 - gridR2[i]);
      const rx = x * cosR + z * sinR, rz = -x * sinR + z * cosR;
      const fy = y * cosT - rz * sinT, fz = y * sinT + rz * cosT;
      const lat = Math.asin(fy > 1 ? 1 : fy < -1 ? -1 : -fy) * DEG;
      const lon = Math.atan2(rx, fz) * DEG;
      let land = 0;
      if (bmp) {
        const br = ((90 - lat) / LAT_STEP) | 0, bc = ((lon + 180) / LON_STEP) | 0;
        if (br >= 0 && br < BMP_H && bc >= 0 && bc < BMP_W) land = bmp[br * BMP_W + bc];
      }
      cellBx[i] = c * charW; cellBy[i] = byBase; cellLand[i] = land; cellActive[i] = 1;
    }
  }
}

// Repel helper — extracted to avoid duplication across passes
function applyRepel(px: number, py: number, halfCW: number, halfCH: number, trail: { x: number; y: number }[], trailLen: number, TRAIL_LEN: number): [number, number] {
  const cx = px + halfCW, cy = py + halfCH;
  let fx = 0, fy = 0;
  for (let t = 0; t < trailLen; t++) {
    const mx = cx - trail[t].x, my = cy - trail[t].y;
    const d2 = mx * mx + my * my;
    if (d2 >= REPEL_R2 || d2 === 0) continue;
    const str = 1 - t / TRAIL_LEN;
    const rad = REPEL_R * (0.5 + str * 0.5);
    if (d2 >= rad * rad) continue;
    const d = Math.sqrt(d2);
    const f = (1 - d / rad) * REPEL_STR * str;
    fx += (mx / d) * f; fy += (my / d) * f;
  }
  return [px + fx, py + fy];
}

// ── Component ────────────────────────────────────────────────────────

const COLORS = { land: "#F1F5F9", earth: "#64748B", bg: "#0A0A0A" };
const TRAIL_MAX = 8;

export function AsciiGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const angleRef = useRef(0);
  const tiltRef = useRef(-0.3);
  const velRef = useRef({ angle: 0, tilt: 0 });
  const bmpRef = useRef<Uint8Array | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const smoothRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0 });
  const lastRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0, charW: 0, charH: 0, fontSize: 0 });
  const skipRef = useRef(0);

  useEffect(() => {
    fetch("/globe.json")
      .then(r => r.json())
      .then(geo => { bmpRef.current = bakeBitmap(parseLand(geo)); })
      .catch(() => {});
  }, []);

  const animate = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { frameRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext("2d");
    if (!ctx) { frameRef.current = requestAnimationFrame(animate); return; }

    if (!lastRef.current) lastRef.current = t;
    const dt = Math.min((t - lastRef.current) / 1000, 0.1);
    lastRef.current = t;

    // Physics (every frame)
    const vel = velRef.current;
    if (!dragRef.current.active) {
      vel.angle *= 0.95; vel.tilt *= 0.95;
      if (Math.abs(vel.angle) < 0.001 && Math.abs(vel.tilt) < 0.001) {
        vel.angle = 0; vel.tilt = 0; angleRef.current += dt * 0.12;
      } else {
        angleRef.current += vel.angle;
        tiltRef.current = Math.max(-1.2, Math.min(1.2, tiltRef.current + vel.tilt));
      }
    }

    // 30fps unless dragging
    skipRef.current++;
    if (!dragRef.current.active && skipRef.current & 1) {
      frameRef.current = requestAnimationFrame(animate); return;
    }

    // Init size once
    const sz = sizeRef.current;
    if (!sz.fontSize) {
      const fs = parseFloat(getComputedStyle(canvas).fontSize) || 5.5;
      ctx.font = `${fs}px JetBrains Mono,monospace`;
      const cw = ctx.measureText("#").width || fs * 0.6;
      sz.fontSize = fs; sz.charW = cw; sz.charH = fs * 1.15;
      sz.w = Math.ceil(COLS * cw); sz.h = Math.ceil(ROWS * sz.charH);
      canvas.width = sz.w; canvas.height = sz.h;
    }

    const rotY = angleRef.current, tilt = tiltRef.current;
    const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

    computeGrid(rotY, tilt, bmpRef.current, sz.charW, sz.charH);

    // ── Clear + bg circle ──
    ctx.clearRect(0, 0, sz.w, sz.h);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.ellipse(sz.w * 0.5, sz.h * 0.5, sz.w * 0.5, sz.h * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // ── Mouse trail ──
    const trail = trailRef.current;
    const raw = !dragRef.current.active ? mouseRef.current : null;
    const sm = smoothRef.current;
    if (raw) {
      if (sm) { sm.x += (raw.x - sm.x) * 0.3; sm.y += (raw.y - sm.y) * 0.3; }
      else smoothRef.current = { x: raw.x, y: raw.y };
      const c = smoothRef.current!;
      trail.unshift({ x: c.x, y: c.y });
      if (trail.length > TRAIL_MAX) trail.length = TRAIL_MAX;
    } else {
      smoothRef.current = null;
      if (trail.length > 0) trail.pop();
    }
    const trailLen = trail.length;
    const hasTrail = trailLen > 0;
    const hcw = sz.charW * 0.5, hch = sz.charH * 0.5;

    ctx.textBaseline = "top";
    ctx.font = `${sz.fontSize}px JetBrains Mono,monospace`;

    // ── Pass 1: Earth (batched, no shadow) ──
    ctx.shadowBlur = 0; ctx.globalAlpha = 0.4; ctx.fillStyle = COLORS.earth;
    for (let i = 0; i < TOTAL; i++) {
      if (!cellActive[i] || cellLand[i]) continue;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) [px, py] = applyRepel(px, py, hcw, hch, trail, trailLen, TRAIL_MAX);
      ctx.fillText(".", px, py);
    }

    // ── Pass 2: Land (batched, no shadow) ──
    ctx.shadowBlur = 0; ctx.globalAlpha = 0.6; ctx.fillStyle = COLORS.land;
    for (let i = 0; i < TOTAL; i++) {
      if (!cellActive[i] || !cellLand[i] || gridR2[i] > 0.9) continue;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) [px, py] = applyRepel(px, py, hcw, hch, trail, trailLen, TRAIL_MAX);
      ctx.fillText("#", px, py);
    }

    // ── Pass 3: Rim glow (few cells) ──
    ctx.shadowColor = "#ffffff"; ctx.fillStyle = "#ffffff";
    for (let i = 0; i < TOTAL; i++) {
      if (!cellActive[i] || !cellLand[i] || gridR2[i] <= 0.9) continue;
      ctx.shadowBlur = 40 * ((gridR2[i] - 0.9) * 10); // (r2-0.9)/0.1
      ctx.globalAlpha = 1;
      let px = cellBx[i], py = cellBy[i];
      if (hasTrail) [px, py] = applyRepel(px, py, hcw, hch, trail, trailLen, TRAIL_MAX);
      ctx.fillText("#", px, py);
    }
    ctx.shadowBlur = 0;

    // ── Arcs ──
    ctx.shadowColor = "#ffffff"; ctx.lineCap = "round";
    const ts = t / 1000;
    const totalCycle = 1 + TAIL_LEN;

    for (const arc of arcXYZ) {
      const phase = (ts / arc.spd) % totalCycle;
      const head = phase < 1 ? phase : 1;
      const tail = phase > TAIL_LEN ? phase - TAIL_LEN : 0;

      // Project arc path
      let prevX = 0, prevY = 0, prevT = -1, prevFade = 0;
      let drewAny = false;

      ctx.shadowBlur = 4; ctx.strokeStyle = "#ffffff";

      for (let s = 0; s <= ARC_STEPS; s++) {
        const st = s * ARC_STEP_INV;
        if (st < tail - 0.05 || st > head + 0.05) continue; // skip irrelevant steps

        const p = slerp(arc.a, arc.b, st);
        const alt = arc.maxAlt * 4 * st * (1 - st);
        const scale = 1 + alt;
        const proj = project(p[0] * scale, p[1] * scale, p[2] * scale, cosR, sinR, cosT, sinT, sz.w, sz.h);
        if (!proj) { prevT = -1; continue; }

        const fade = Math.max(0, Math.min(1, (proj.z + 0.3) * 2)); // 1/(0.5) = 2

        if (prevT >= 0 && st - prevT < ARC_STEP_INV * 2.5) {
          const mid = (prevT + st) * 0.5;
          if (mid >= tail && mid <= head) {
            const progress = (mid - tail) / TAIL_LEN;
            ctx.lineWidth = 3 * progress + 0.3;
            ctx.globalAlpha = progress * progress * Math.min(prevFade, fade);
            ctx.beginPath();
            ctx.moveTo(prevX, prevY);
            ctx.lineTo(proj.x, proj.y);
            ctx.stroke();
            drewAny = true;
          }
        }

        prevX = proj.x; prevY = proj.y; prevT = st; prevFade = fade;
      }

      // Head dot
      if (drewAny && prevT >= 0) {
        ctx.shadowBlur = 12; ctx.globalAlpha = prevFade; ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(prevX, prevY, 2, 0, Math.PI * 2); ctx.fill();
      }

      // Endpoint dots
      ctx.shadowColor = "#E42313"; ctx.shadowBlur = 8; ctx.fillStyle = "#E42313";
      for (const ep of [arc.aS, arc.bS]) {
        const proj = project(ep[0], ep[1], ep[2], cosR, sinR, cosT, sinT, sz.w, sz.h);
        if (!proj) continue;
        ctx.globalAlpha = 0.8 * Math.max(0, Math.min(1, (proj.z + 0.3) * 2));
        ctx.beginPath(); ctx.arc(proj.x, proj.y, 1.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowColor = "#ffffff";
    }

    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    frameRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [animate]);

  const onMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.lastX, dy = e.clientY - dragRef.current.lastY;
      angleRef.current -= dx * 0.008;
      tiltRef.current = Math.max(-1.2, Math.min(1.2, tiltRef.current + dy * 0.008));
      velRef.current = { angle: -dx * 0.008, tilt: dy * 0.008 };
      dragRef.current.lastX = e.clientX; dragRef.current.lastY = e.clientY;
    } else {
      mouseRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    }
  }, []);

  const onDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    mouseRef.current = null;
  }, []);

  const onUp = useCallback(() => { dragRef.current.active = false; }, []);
  const onLeave = useCallback(() => { dragRef.current.active = false; mouseRef.current = null; }, []);

  return (
    <div style={{ perspective: "800px" }}>
      <canvas
        ref={canvasRef}
        className="select-none"
        style={{ fontSize: "5.5px", transform: "rotateX(15deg) rotateY(-5deg)", transformOrigin: "center center" }}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseLeave={onLeave}
        aria-hidden="true"
      />
    </div>
  );
}
