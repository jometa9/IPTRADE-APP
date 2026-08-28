import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-lg border border-[hsl(var(--input))] bg-transparent px-3 py-1 text-sm placeholder:text-gray-400',
        'outline-none focus:outline-none focus-visible:outline-none',
        'ring-0 ring-offset-0 focus:ring-0 focus-visible:ring-0',
        'focus:border-[hsl(var(--input))] focus-visible:border-[hsl(var(--input))]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input };
