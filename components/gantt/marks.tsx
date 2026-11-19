import { cx } from "@/components/ui";

/**
 * 금형 교체 표시. 생산배대와 같은 시각 언어: 큰 네모 = Full set, 작은 네모 = B/M.
 * assumed = 이력으로 판단하지 못해 가정한 교체(점선).
 */
export function ChangeoverMark({ type, assumed, className }: { type: "BM" | "FULL"; assumed?: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={type === "FULL" ? "Full set 교체" : "B/M 교체"}
      title={type === "FULL" ? "Full set 교체 (큰 네모)" : "B/M 교체 (작은 네모)"}
      className={cx(
        "inline-block shrink-0 border border-[#c00000] bg-[#f4b6b6]",
        type === "FULL" ? "h-[14px] w-[14px]" : "h-[9px] w-[9px]",
        assumed ? "border-dashed" : "",
        className,
      )}
    />
  );
}
