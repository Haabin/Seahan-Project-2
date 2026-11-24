import { cx } from "@/components/ui";

/** 원본 화면의 교체 색: B/M교체 · FULLSET교체 · 교체유형 미입력(기본값) */
export const CHANGEOVER_COLOR = { BM: "#2f3e6e", FULL: "#0b1445", DEFAULTED: "#c9a13a" } as const;

function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
}

/**
 * 금형 교체 표시 (원본 화면과 같은 색 박스).
 * 짧은 표기: B/M = B/M교체, FULL = FULLSET교체, 익일 = 익일가동이 켜진 교체(교체일 생산 0), ? = 교체유형 미입력 · 기본값 적용, 3h = 교체 소요시간.
 * 칸이 넓으면 전체 용어와 가동(생산 가능)시간을 적고, 마우스를 올리면 전체 설명이 나온다.
 * assumed = 초안 자동 생성이 이력 없이 가정한 교체(점선 테두리, 확인 필요).
 */
export function ChangeoverMark({
  type,
  hours,
  defaulted,
  nextDay,
  assumed,
  className,
}: {
  type: "BM" | "FULL";
  hours?: number | null;
  defaulted?: boolean;
  nextDay?: boolean;
  assumed?: boolean;
  className?: string;
}) {
  const short = type === "FULL" ? "FULL" : "B/M";
  const long = type === "FULL" ? "FULLSET교체" : "B/M교체";
  const h = hours != null && hours > 0 ? fmtHours(hours) : "";
  const avail = hours != null && hours > 0 && hours < 24 ? fmtHours(24 - hours) : "";
  const tail = `${nextDay ? " 익일" : ""}${defaulted ? " ?" : ""}`;
  const title = [
    long,
    nextDay ? "익일 가동 (교체일 생산 0)" : h ? `교체 소요시간 ${h}` : "",
    !nextDay && avail ? `가동(생산 가능)시간 ${avail}` : "",
    defaulted ? "교체유형 미입력 · 기본값 적용" : "",
    assumed ? "전환 이력이 없어 가정한 교체 · 확인 필요" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      style={{ background: defaulted ? CHANGEOVER_COLOR.DEFAULTED : CHANGEOVER_COLOR[type] }}
      className={cx(
        "tnum inline-flex max-w-full shrink-0 items-center overflow-hidden rounded-[4px] px-1.5 text-[10px] font-semibold leading-[15px] whitespace-nowrap",
        defaulted ? "text-[#2b2205]" : "text-white",
        assumed ? "outline outline-1 outline-dashed outline-offset-1 outline-warn" : "",
        className,
      )}
    >
      {/* 좁은 칸: 짧은 표기 */}
      <span className="@[150px]:hidden">
        {short}
        {nextDay ? "" : h ? ` ${h}` : ""}
        {tail}
      </span>
      {/* 넓은 칸: 전체 용어 + 가동시간 */}
      <span className="hidden @[150px]:inline">
        {long}
        {nextDay ? "" : h ? ` ${h}` : ""}
        {!nextDay && avail ? ` · 가동 ${avail}` : ""}
        {tail}
      </span>
    </span>
  );
}

/** 범례용 색 칸 */
export function ChangeoverSwatch({ kind }: { kind: keyof typeof CHANGEOVER_COLOR }) {
  return <span className="inline-block h-3 w-4 rounded-[2px]" style={{ background: CHANGEOVER_COLOR[kind] }} />;
}
