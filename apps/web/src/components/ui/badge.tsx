import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

const badgeVariants = cva(
  "inline-flex items-center gap-2 font-medium",
  {
    variants: {
      variant: {
        default: "text-text-secondary text-sm",
        tag: "bg-accent-500 text-white text-[11px] font-bold uppercase tracking-wider px-2 py-0.5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, className }))} {...props}>
      {children}
    </div>
  );
}

export { badgeVariants };
