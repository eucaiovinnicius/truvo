import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export function Button({
  children,
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' }) {
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const styles = {
    default: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
    primary: 'bg-teal-500 text-slate-950 hover:bg-teal-400',
    ghost: 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
  }[variant];
  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Select({ children, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 focus:border-teal-500 focus:outline-none ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-teal-500 focus:outline-none ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-500">
      {label}
      {children}
    </label>
  );
}
