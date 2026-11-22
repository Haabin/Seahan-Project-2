"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, inputSmClass } from "@/components/ui";

export interface ComboProduct {
  id: string;
  code: string;
  name: string;
}

/** 검색용 정규화: 공백·기호를 빼고 소문자로 ("1.8L HD - N" → "1.8lhdn") */
function fold(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s\-_/()[\]#]/g, "");
}

/** 제품 목록에서 검색어에 맞는 것을 고른다. 여러 낱말을 띄어 쓰면 모두 들어 있는 것만 */
export function filterProducts<T extends ComboProduct>(products: T[], query: string, limit = 60): T[] {
  const words = query.normalize("NFC").trim().split(/\s+/).map(fold).filter(Boolean);
  if (!words.length) return products.slice(0, limit);
  const scored: { p: T; score: number }[] = [];
  for (const p of products) {
    const hay = `${fold(p.name)} ${fold(p.code)}`;
    if (!words.every((w) => hay.includes(w))) continue;
    // 이름이 검색어로 시작하면 위로
    scored.push({ p, score: fold(p.name).startsWith(words[0]) ? 0 : fold(p.code).startsWith(words[0]) ? 1 : 2 });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name, "ko"))
    .slice(0, limit)
    .map((x) => x.p);
}

/**
 * 검색해서 고르는 제품 선택 칸. 글자를 치면 품명·품번에 그 글자가 든 제품만 남는다.
 * ↑↓ 로 고르고 Enter 로 선택, Esc 로 닫는다. 고른 뒤 글자를 고치면 선택이 풀린다.
 */
export function ProductCombobox({
  products,
  value,
  onChange,
  label,
  placeholder = "품명·품번으로 검색",
  disabled,
  autoFocus,
  emptyOptionLabel,
  onDismiss,
}: {
  products: ComboProduct[];
  value: string;
  onChange: (productId: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** 나타나자마자 목록을 연다(표 안에서 눌렀을 때) */
  autoFocus?: boolean;
  /** 주면 목록 맨 위에 "선택 안 함" 줄을 둔다 (예: "연결 안 함") */
  emptyOptionLabel?: string;
  /** 고르거나, 고르지 않고 닫았을 때 */
  onDismiss?: () => void;
}) {
  const listId = useId();
  const selected = useMemo(() => products.find((p) => p.id === value) ?? null, [products, value]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const text = selected && !open ? `${selected.name} (${selected.code})` : query;
  const matches = useMemo(() => filterProducts(products, open ? query : ""), [products, query, open]);
  const total = useMemo(() => (query.trim() ? filterProducts(products, query, products.length).length : products.length), [products, query]);

  const close = () => {
    setOpen(false);
    onDismiss?.();
  };
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        onDismiss?.();
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onDismiss]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(p: ComboProduct | null) {
    onChange(p?.id ?? "");
    setQuery("");
    setOpen(false);
    onDismiss?.();
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        className={cx(inputSmClass, selected && !open ? "font-medium text-text" : "")}
        placeholder={placeholder}
        value={text}
        onFocus={() => {
          setQuery("");
          setActive(0);
          setOpen(true);
        }}
        onChange={(e) => {
          if (value) onChange("");
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            if (open && matches[active]) {
              e.preventDefault();
              pick(matches[active]);
            }
          } else if (e.key === "Escape") {
            close();
          }
        }}
      />
      {value && !open ? (
        <button
          type="button"
          aria-label="제품 선택 지우기"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1 text-text-faint hover:text-danger"
          onClick={() => {
            onChange("");
            setQuery("");
          }}
        >
          ×
        </button>
      ) : null}
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-[280px] overflow-hidden rounded-[var(--radius-sm)] border border-border bg-white text-left font-normal shadow-[0_8px_24px_rgba(0,16,78,0.12)]" style={{ width: "100%" }}>
          <ul ref={listRef} id={listId} role="listbox" aria-label={`${label} 검색 결과`} className="max-h-64 overflow-auto py-1 text-xs">
            {emptyOptionLabel && !query.trim() ? (
              <li
                role="option"
                aria-selected={false}
                className="cursor-pointer px-2.5 py-1.5 text-text-muted hover:bg-bg-sub"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(null);
                }}
              >
                {emptyOptionLabel}
              </li>
            ) : null}
            {matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === active}
                data-idx={i}
                className={cx("flex cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5", i === active ? "bg-brand-tint text-brand-deep" : "hover:bg-bg-sub", p.id === value ? "font-semibold" : "")}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // 입력 칸의 포커스를 잃기 전에 고른다
                  e.preventDefault();
                  pick(p);
                }}
              >
                <span className="truncate">{p.name}</span>
                <span className="tnum shrink-0 text-text-faint">{p.code}</span>
              </li>
            ))}
            {matches.length === 0 ? <li className="px-2.5 py-3 text-center text-text-muted">맞는 제품이 없습니다. 다른 글자로 검색해 보세요.</li> : null}
          </ul>
          <div className="border-t border-border bg-bg-sub px-2.5 py-1 text-[11px] text-text-muted">
            {query.trim() ? `검색 결과 ${total}개` : `전체 ${products.length}개 · 글자를 치면 줄어듭니다`}
            {total > matches.length ? ` (위 ${matches.length}개만 표시)` : ""} · ↑↓ 이동 · Enter 선택
          </div>
        </div>
      ) : null}
    </div>
  );
}
