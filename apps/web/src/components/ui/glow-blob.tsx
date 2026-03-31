import { cn } from "@/lib/utils";

// Each shape: [borderRadius, rotate, skewX, skewY]
// Warped circles → organic triangular rings
const BLOB_SHAPES = [
  { br: "45% 55% 60% 40% / 55% 40% 60% 45%", rotate: 25, skewX: 18, skewY: 12 },
  { br: "55% 45% 40% 60% / 40% 60% 45% 55%", rotate: -40, skewX: -15, skewY: 20 },
  { br: "50% 60% 45% 55% / 60% 45% 55% 40%", rotate: 70, skewX: 20, skewY: -10 },
  { br: "40% 55% 60% 50% / 50% 55% 40% 60%", rotate: -15, skewX: -20, skewY: 15 },
] as const;

interface GlowBlobProps {
  size?: string;
  color?: string;
  opacity?: string;
  blur?: string;
  shape?: number;
  className?: string;
}

export function GlowBlob({
  size = "w-72 h-72",
  color = "var(--accent)",
  opacity = "opacity-20",
  blur = "blur-[40px]",
  shape = 0,
  className,
}: GlowBlobProps) {
  const s = BLOB_SHAPES[shape % BLOB_SHAPES.length];

  return (
    <div
      className={cn("absolute pointer-events-none", size, opacity, blur, className)}
      style={{
        borderRadius: s.br,
        transform: `rotate(${s.rotate}deg) skewX(${s.skewX}deg) skewY(${s.skewY}deg)`,
        background: `radial-gradient(ellipse at center, transparent 30%, ${color} 50%, ${color} 65%, transparent 70%)`,
      }}
    />
  );
}
