import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

const buttonVariants = cva(
  "group inline-flex items-center justify-center gap-2 font-semibold transition-all cursor-pointer whitespace-nowrap box-border no-underline",
  {
    variants: {
      variant: {
        primary: "bg-accent-500 text-white hover:bg-accent-600",
        secondary: "border border-border text-text-primary hover:bg-bg-surface",
        ghost: "text-text-secondary hover:text-text-primary",
        dark: "bg-bg-inverted text-text-inverted hover:opacity-90",
      },
      size: {
        sm: "px-4 py-2 text-sm",
        md: "px-6 py-3 text-[15px]",
        lg: "px-8 py-4 text-base",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  href?: string;
}

export function Button({
  className,
  variant,
  size,
  href,
  children,
  ...props
}: ButtonProps) {
  if (href) {
    return (
      <a href={href} className={cn(buttonVariants({ variant, size, className }))}>
        {children}
      </a>
    );
  }

  return (
    <button className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {children}
    </button>
  );
}

export { buttonVariants };
