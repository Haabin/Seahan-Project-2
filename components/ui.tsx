import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}
export { cx };

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const sizes = size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-brand text-white hover:bg-brand-darkest",
    secondary: "bg-white text-brand border border-brand/40 hover:bg-brand-tint",
    ghost: "bg-transparent text-text-muted hover:bg-bg-sub hover:text-text",
    danger: "bg-danger text-white hover:brightness-95",
  };
  return <button className={cx(base, sizes, variants[variant], className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-[var(--radius-md)] border border-border bg-white", className)} {...props} />;
}

export function CardHeader({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-brand-deep">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

type Tone = "danger" | "warn" | "ok" | "info" | "neutral" | "surplus";
const toneClass: Record<Tone, string> = {
  danger: "bg-danger-bg text-danger border-danger/30",
  warn: "bg-warn-bg text-[#9a6b00] border-warn/40",
  ok: "bg-ok-bg text-ok border-ok/30",
  info: "bg-info-bg text-brand border-accent/30",
  neutral: "bg-bg-sub text-text-muted border-border",
  surplus: "bg-surplus-bg text-text-muted border-border",
};

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", toneClass[tone], className)}
      {...props}
    />
  );
}

export function PageHeader({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-brand-deep">{title}</h1>
        {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-white px-4 py-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="tnum mt-1 text-xl font-semibold text-brand-deep">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-text-faint">{hint}</div> : null}
    </div>
  );
}

export const inputClass =
  "h-9 w-full rounded-[var(--radius-sm)] border border-border bg-white px-3 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
export const inputSmClass =
  "h-7 w-full rounded-[var(--radius-sm)] border border-border bg-white px-2 text-xs text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
