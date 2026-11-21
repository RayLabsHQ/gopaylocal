// Brand mark "Parity percent" — shared by login, sidebar, and mobile header.
// Keep geometry in sync with public/favicon.svg and the web app's Logo.astro.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="GoPayLocal logo"
    >
      <path fill="#E42313" fillRule="evenodd" d="M0 0 H28 L0 28 Z M5.5 5.5 h6 v6 h-6 Z" />
      <path fill="#FFFFFF" fillRule="evenodd" d="M32 4 V32 H4 Z M20.5 20.5 h6 v6 h-6 Z" />
    </svg>
  )
}
