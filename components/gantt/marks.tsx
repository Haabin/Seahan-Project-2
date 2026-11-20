import { cx } from "@/components/ui";

/**
 * 금형 교체 표시. 원본 화면과 같은 남색 박스("B/M 2h", "Full 6h")를 쓴다.
 * hours 를 주면 교체 시간을 함께 적는다. assumed = 이력으로 판단하지 못해 가정한 교체(점선 테두리).
 */
export function ChangeoverMark({ type, hours, assumed, className }: { type: "BM" | "FULL"; hours?: number | null; assumed?: boolean; className?: string }) {
  const label = type === "FULL" ? "Full" : "B/M";
  const h = hours != null && hours > 0 ? ` ${Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10}h` : "";
  return (
    <span
      role="img"
      aria-label={type === "FULL" ? "Full set 교체" : "B/M 교체"}
      title={`${type === "FULL" ? "Full set 교체" : "B/M 교체"}${h ? ` · 손실${h}` : ""}${assumed ? " · 확인 필요" : ""}`}
      className={cx(
        "tnum inline-flex shrink-0 items-center rounded-[4px] bg-brand-deep px-1.5 text-[10px] font-semibold leading-[15px] text-white whitespace-nowrap",
        assumed ? "outline outline-1 outline-dashed outline-offset-1 outline-warn" : "",
        className,
      )}
    >
      {label}
      {h}
    </span>
  );
}
