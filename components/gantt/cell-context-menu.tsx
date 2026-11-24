"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";
import type { MenuAction, MenuItem } from "@/components/gantt/clipboard";

/**
 * 생산계획표 칸의 오른쪽 버튼 메뉴. 셀 편집창·제품 검색 목록처럼 화면 기준(fixed)으로 띄워 표·카드 안에서 잘리지 않는다.
 * 바깥 누르기 · Esc · 스크롤 · 창 크기 변경 · 창 포커스 잃음 · 항목 선택이면 닫힌다.
 */
export function CellContextMenu({ x, y, items, onSelect, onClose }: { x: number; y: number; items: MenuItem[]; onSelect: (a: MenuAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 그린 뒤 크기를 재서 화면 오른쪽·아래 끝에서 잘리지 않게 접는다
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = x + w + 8 > window.innerWidth ? Math.max(8, x - w) : x;
    const top = y + h + 8 > window.innerHeight ? Math.max(8, y - h) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    // 처음 쓸 수 있는 항목에 포커스 (키보드로 고를 수 있게)
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next].focus();
      }
    };
    const close = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="cell-context-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[148px] rounded-[var(--radius-sm)] border border-border bg-white py-1 text-xs shadow-[0_8px_24px_rgba(0,16,78,0.12)]"
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? "visible" : "hidden" }}
    >
      {items.map((it) => (
        <button
          key={it.action}
          type="button"
          role="menuitem"
          data-testid={`menu-${it.action}`}
          disabled={!it.enabled}
          title={it.enabled ? undefined : it.reason}
          onClick={() => {
            if (!it.enabled) return;
            onClose();
            onSelect(it.action);
          }}
          className={cx(
            "block w-full px-3 py-1.5 text-left",
            it.action === "cancel" ? "border-t border-border text-text-muted" : "text-text",
            it.enabled ? "hover:bg-bg-sub focus:bg-bg-sub focus:outline-none" : "cursor-not-allowed text-text-faint",
          )}
        >
          {it.label}
          {!it.enabled && it.reason ? <span className="mt-0.5 block max-w-[240px] whitespace-normal text-[10px] leading-snug text-text-faint">{it.reason}</span> : null}
        </button>
      ))}
    </div>
  );
}
