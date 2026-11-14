import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui's Button, re-skinned to Mola's tokens (web.md 6.1): 14px radius everywhere, a 56px
// touch target, and a 1px press. No stock zinc theme survives here.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2.5 whitespace-nowrap rounded-[14px] font-bold transition-transform duration-100 ease-out-long active:translate-y-px active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-ink',
        ticket: 'bg-ticket text-ink',
        onGo: 'bg-go-ink text-go',
        quiet: 'text-muted underline underline-offset-4',
      },
      size: {
        lg: 'min-h-14 px-6 text-[1.375rem]',
        md: 'min-h-12 px-5 text-[1.0625rem]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'lg' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
