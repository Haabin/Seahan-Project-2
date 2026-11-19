/**
 * 간트 셀의 교체 표시: 교체 종류 · 소요시간 · 생산 가능시간을 글자로 보여준다.
 * 현장에서 칸 크기만으로 교체 종류를 구분하기 어렵다는 인터뷰 요구사항 반영.
 *
 * 칸 너비에 따라 표기를 바꾼다 (CSS 컨테이너 쿼리, JS 측정 없음 → 셀 높이·드래그 동작 영향 없음)
 *   ~ 99px   : 짧은 표기만       'B/M 3h', 'FULL 익일', 'B/M? 3h'
 *   100px ~  : 짧은 표기 + 가동  'B/M 3h 가동 21h'
 *   150px ~  : 전체 용어 + 가동  'B/M교체 3h 가동 21h'
 * 전체 설명은 마우스를 올리면(title) 보인다.
 */
import { badgeLabels, type CellTimeInfo } from "@/lib/engine/changeover";
import { cx } from "@/components/ui";

export function ChangeoverBadge({ info, defaultLabel, className }: { info: CellTimeInfo; defaultLabel?: string; className?: string }) {
  // 교체 없는 칸은 비가동 시간을 직접 넣었을 때만 배지 (배지 글자·모양은 기준 시간 칸과 같음)
  if (info.changeover === "NONE" && !info.isDowntime && !(info.overridden && (info.lostHours ?? 0) > 0)) return null;
  const labels = badgeLabels(info, defaultLabel);
  const tone = info.defaulted
    ? "bg-warn text-white"
    : info.changeover === "FULL"
      ? "bg-brand-darkest text-white"
      : "bg-brand-deep text-white";
  return (
    // -mx-1: 셀 안쪽 여백 일부를 배지 줄에 써서 하루짜리 칸에서도 짧은 표기가 다 들어가게 한다
    <div className={cx("@container -mx-1 min-w-0", className)} title={labels.title} data-testid="changeover-badge">
      <div className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[10px] leading-none">
        <span className={cx("min-w-0 shrink overflow-hidden text-ellipsis rounded-[3px] px-[3px] py-[2px] font-semibold", tone)}>
          <span className="@min-[150px]:hidden">{labels.short}</span>
          <span className="hidden @min-[150px]:inline">{labels.full}</span>
        </span>
        {info.availableHours != null ? (
          <span className="tnum hidden shrink-0 font-medium text-text @min-[100px]:inline">가동 {fmtH(info.availableHours)}</span>
        ) : null}
      </div>
    </div>
  );
}

function fmtH(h: number): string {
  return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
}
