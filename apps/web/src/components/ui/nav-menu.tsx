import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href?: string;
  panel?: React.ReactNode;
}

interface NavMenuProps {
  items: NavItem[];
}

export function NavMenu({ items }: NavMenuProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleEnter = (index: number) => {
    clearTimeout(timeoutRef.current);
    setActiveIndex(index);
  };

  const handleLeave = () => {
    timeoutRef.current = setTimeout(() => setActiveIndex(null), 150);
  };

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return (
    <nav className="relative hidden md:flex items-center gap-0.5">
      {items.map((item, i) => (
        <div
          key={item.label}
          onMouseEnter={() => item.panel ? handleEnter(i) : setActiveIndex(null)}
          onMouseLeave={handleLeave}
        >
          {item.href && !item.panel ? (
            <a
              href={item.href}
              className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors no-underline"
            >
              {item.label}
            </a>
          ) : (
            <button
              className={cn(
                "px-3 py-2 text-sm font-medium transition-colors flex items-center gap-1 border-none bg-transparent outline-none cursor-default",
                activeIndex === i ? "text-text-primary" : "text-text-secondary hover:text-text-primary"
              )}
            >
              {item.label}
              <svg
                className={cn(
                  "h-3 w-3 transition-transform duration-200",
                  activeIndex === i && "rotate-180"
                )}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          )}

          {item.panel && activeIndex === i && (
            <div
              className="absolute top-full left-1/2 -translate-x-1/2 mt-1 bg-bg border border-border shadow-xl shadow-black/15 z-50 rounded-lg overflow-hidden"
              onMouseEnter={() => handleEnter(i)}
              onMouseLeave={handleLeave}
            >
              {item.panel}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

// ─── Panel sub-components ──────────────────────────────

interface NavPanelGridProps {
  children: React.ReactNode;
  columns?: 2 | 3;
}

export function NavPanelGrid({ children, columns = 2 }: NavPanelGridProps) {
  return (
    <div className={cn(
      "grid gap-1.5 p-2",
      columns === 2 ? "grid-cols-2 w-[460px]" : "grid-cols-3 w-[580px]"
    )}>
      {children}
    </div>
  );
}

interface NavPanelItemProps {
  href: string;
  icon?: React.ReactNode;
  title: string;
  description: string;
}

export function NavPanelItem({ href, icon, title, description }: NavPanelItemProps) {
  return (
    <a
      href={href}
      className="flex items-center gap-3 px-3.5 py-3 border border-border hover:border-text-muted hover:bg-bg-surface transition-colors group no-underline"
    >
      {icon && (
        <div className="shrink-0 h-9 w-9 rounded-md bg-accent-light flex items-center justify-center text-accent-500">
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary group-hover:text-accent-text transition-colors no-underline">
          {title}
        </p>
        <p className="text-[13px] text-text-muted mt-1 leading-normal no-underline">{description}</p>
      </div>
    </a>
  );
}
