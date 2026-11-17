/**
 * 간트 셀의 교체 표시: 교체 종류 · 소요시간 · 생산 가능시간을 글자로 보여준다.
 * 현장에서 칸 크기만으로 교체 종류를 구분하기 어렵다는 인터뷰 요구사항 반영.
 */
import type { CellTimeInfo } from "@/lib/engine/changeover";
import { cx } from "@/components/ui";

export function ChangeoverBadge({ info, className }: { info: CellTimeInfo; className?: string }) {
  if (info.changeover === "NONE" && !info.isDowntime) return null;
  const tone = info.defaulted
    ? "bg-warn text-white"
    : info.changeover === "FULL"
      ? "bg-brand-darkest text-white"
      : "bg-brand-deep text-white";
  const hours = info.nextDayStart ? "익일가동" : info.lostHours != null ? `${fmtH(info.lostHours)}` : "시간 ?";
  return (
    <div className={cx("flex min-w-0 items-center gap-1 text-[10px] leading-none", className)} title={info.text}>
      <span className={cx("shrink-0 rounded-[3px] px-1 py-[2px] font-semibold", tone)}>
        {info.label}
        {info.defaulted ? "(기본값)" : ""} {hours}
      </span>
      {info.availableHours != null ? <span className="tnum shrink-0 font-medium text-text">가동 {fmtH(info.availableHours)}</span> : null}
    </div>
  );
}

function fmtH(h: number): string {
  return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
}
