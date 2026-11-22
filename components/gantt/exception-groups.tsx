"use client";

import { useMemo, useState } from "react";
import type { DraftException, DraftExceptionCode } from "@/lib/engine/draft";
import { cx } from "@/components/ui";

/** 종류별 제목 · 할 일 · 심각도. 위에서부터 급한 순서 */
export const EXCEPTION_GROUPS: { code: DraftExceptionCode; title: string; todo: string; tone: "danger" | "warn" }[] = [
  { code: "SHORTAGE", title: "납기 내 수량 부족", todo: "다른 호기로 나누거나 납기를 조정하세요", tone: "danger" },
  { code: "MOLD_CONFLICT", title: "금형 충돌", todo: "같은 날 같은 금형이 두 호기에 잡혔습니다. 한쪽 날짜를 옮기세요", tone: "danger" },
  { code: "UNMATCHED_ORDER", title: "주문 품명 매칭 안 됨", todo: "주문 입력에서 제품을 연결하세요", tone: "danger" },
  { code: "CONSTRAINT", title: "제약을 지키지 못함", todo: "허용 금형·하루 교체 횟수를 확인하세요", tone: "warn" },
  { code: "MOLD_UNKNOWN", title: "금형 확인 필요", todo: "금형번호를 직접 고르세요", tone: "warn" },
  { code: "CHANGEOVER_ASSUMED", title: "교체유형 확인 필요 (Full 가정)", todo: "B/M인지 Full set인지 고르세요", tone: "warn" },
  { code: "NEW_PRODUCT", title: "신규 제품 · 임시 배정", todo: "배정된 호기가 맞는지 확인하세요", tone: "warn" },
];

/** 종류별로 묶고, 글이 똑같은 항목은 하나로 합친다(같은 제품의 주문이 여러 건이면 같은 안내가 반복된다) */
export function groupExceptions(exceptions: DraftException[]): { code: DraftExceptionCode; items: (DraftException & { count: number })[]; total: number }[] {
  const out: { code: DraftExceptionCode; items: (DraftException & { count: number })[]; total: number }[] = [];
  for (const g of EXCEPTION_GROUPS) {
    const list = exceptions.filter((e) => e.code === g.code);
    if (!list.length) continue;
    const merged: (DraftException & { count: number })[] = [];
    for (const e of list) {
      const same = merged.find((m) => m.message === e.message);
      if (same) same.count++;
      else merged.push({ ...e, count: 1 });
    }
    out.push({ code: g.code, items: merged, total: list.length });
  }
  return out;
}

/**
 * 확인 필요 목록을 종류별로 접었다 펼 수 있게 보여준다.
 * 급한 종류(빨강)는 처음부터 펼쳐 두고, 나머지는 접어 둔다. 항목을 누르면 해당 칸으로 이동한다.
 */
export function ExceptionGroups({ exceptions, onPick }: { exceptions: DraftException[]; onPick: (e: DraftException) => void }) {
  const groups = useMemo(() => groupExceptions(exceptions), [exceptions]);
  const [open, setOpen] = useState<Set<DraftExceptionCode>>(() => new Set(EXCEPTION_GROUPS.filter((g) => g.tone === "danger").map((g) => g.code)));
  const meta = (code: DraftExceptionCode) => EXCEPTION_GROUPS.find((g) => g.code === code)!;
  const allOpen = groups.every((g) => open.has(g.code));

  if (!groups.length) return <p className="px-2 py-3 text-center text-text-muted">확인이 필요한 항목이 없습니다.</p>;
  return (
    <div className="space-y-1.5" data-testid="exception-groups">
      <div className="flex items-center justify-between px-1 text-[11px] text-text-muted">
        <span>
          종류 {groups.length}개 · 항목 {exceptions.length}개
        </span>
        <button className="text-accent hover:underline" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.code)))}>
          {allOpen ? "모두 접기" : "모두 펼치기"}
        </button>
      </div>
      {groups.map((g) => {
        const m = meta(g.code);
        const isOpen = open.has(g.code);
        return (
          <section key={g.code} className={cx("overflow-hidden rounded-[var(--radius-sm)] border", m.tone === "danger" ? "border-danger/40" : "border-warn/50")} data-group={g.code}>
            <button
              aria-expanded={isOpen}
              className={cx("flex w-full items-start gap-2 px-2.5 py-2 text-left", m.tone === "danger" ? "bg-danger-bg" : "bg-warn-bg")}
              onClick={() =>
                setOpen((prev) => {
                  const n = new Set(prev);
                  if (n.has(g.code)) n.delete(g.code);
                  else n.add(g.code);
                  return n;
                })
              }
            >
              <span className="mt-0.5 w-3 shrink-0 text-text-muted">{isOpen ? "▾" : "▸"}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text">{m.title}</span>
                  <span className={cx("tnum shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold text-white", m.tone === "danger" ? "bg-danger" : "bg-warn")}>{g.total}</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-text-muted">{m.todo}</span>
              </span>
            </button>
            {isOpen ? (
              <ul className="divide-y divide-border bg-white">
                {g.items.map((e, i) => (
                  <li key={i}>
                    <button className="block w-full px-2.5 py-1.5 text-left text-text-muted hover:bg-bg-muted hover:text-text" onClick={() => onPick(e)} data-testid="exception-item">
                      {e.message}
                      {e.count > 1 ? <span className="ml-1 text-text-faint">(같은 안내 {e.count}건)</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
