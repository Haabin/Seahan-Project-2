"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";

/**
 * 눈에 띄는 파일 올리기 버튼. 브라우저 기본 「파일 선택」은 숨기고 이 버튼이 대신 연다.
 * 숨긴 입력 칸은 그대로 있어서 같은 파일을 다시 골라도 동작한다.
 */
export function FileButton({
  label = "엑셀파일 업로드",
  busyLabel = "올리는 중…",
  accept = ".xlsx",
  ariaLabel,
  busy,
  disabled,
  size = "md",
  variant = "primary",
  fileName,
  testId,
  onFile,
}: {
  label?: string;
  busyLabel?: string;
  accept?: string;
  /** 숨긴 파일 입력 칸의 이름(테스트·보조기기용) */
  ariaLabel: string;
  busy?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
  /** 고른 파일 이름을 버튼 옆에 보여준다 */
  fileName?: string | null;
  testId?: string;
  onFile: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept={accept}
        aria-label={ariaLabel}
        className="hidden"
        disabled={disabled || busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button type="button" variant={variant} size={size} data-testid={testId} disabled={disabled || busy} onClick={() => ref.current?.click()} className="shrink-0">
        <svg width={size === "sm" ? 14 : 16} height={size === "sm" ? 14 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 20h14" />
        </svg>
        {busy ? busyLabel : label}
      </Button>
      {fileName ? (
        <span className="truncate text-xs text-text-muted" title={fileName}>
          {fileName}
        </span>
      ) : null}
    </span>
  );
}
