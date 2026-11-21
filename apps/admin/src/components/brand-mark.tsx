// Brand mark "Parity percent" in the admin's terminal palette (green + white).
// Geometry matches the other apps' marks and public/favicon.svg.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="GoPayLocal admin logo"
    >
      <path fill="#00FF88" fillRule="evenodd" d="M0 0 H28 L0 28 Z M5.5 5.5 h6 v6 h-6 Z" />
      <path fill="#FFFFFF" fillRule="evenodd" d="M32 4 V32 H4 Z M20.5 20.5 h6 v6 h-6 Z" />
    </svg>
  )
}
