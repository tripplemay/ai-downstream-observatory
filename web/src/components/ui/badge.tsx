import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow",
        outline: "text-foreground",
        red: "border-transparent bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
        yellow: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
        green: "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
        blue: "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
        violet: "border-transparent bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400",
        teal: "border-transparent bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-400",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
