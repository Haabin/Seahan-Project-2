"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/lib/actions/auth";
import type { AppRole } from "@/lib/auth/session";
import { Badge, cx } from "@/components/ui";

const roleLabel: Record<AppRole, string> = { viewer: "조회", planner: "작성", admin: "관리" };

export function TopNav({ displayName, role }: { displayName: string; role: AppRole }) {
  const pathname = usePathname();
  const canWrite = role === "planner" || role === "admin";
  const items = [
    ...(canWrite
      ? [
          { href: "/plan", label: "생산계획표" },
          { href: "/supply", label: "수급 검증" },
          { href: "/seabulk", label: "씨벌크 원료" },
        ]
      : []),
    { href: "/view", label: "계획 조회" },
    { href: "/revisions", label: "Rev 이력" },
    ...(role === "admin" ? [{ href: "/master", label: "기준정보" }] : []),
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-white">
      <div className="mx-auto flex h-12 w-full min-w-[1280px] max-w-[1900px] items-center gap-6 px-5">
        <Link href="/plan" className="flex items-baseline gap-2">
          <span className="text-base font-extrabold tracking-tight text-brand">SAEHAN</span>
          <span className="text-xs font-medium text-text-muted">주간 생산계획</span>
        </Link>
        <nav className="flex items-center gap-1">
          {items.map((it) => {
            const active = pathname === it.href || pathname.startsWith(it.href + "/");
            return (
              <Link
                key={it.href}
                href={it.href}
                className={cx(
                  "rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-brand text-white" : "text-text-muted hover:bg-bg-sub hover:text-text",
                )}
              >
                {it.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-text">{displayName}</span>
          <Badge tone={role === "admin" ? "info" : role === "planner" ? "ok" : "neutral"}>{roleLabel[role]}</Badge>
          <form action={signOutAction}>
            <button className="text-text-muted hover:text-text" type="submit">
              로그아웃
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
