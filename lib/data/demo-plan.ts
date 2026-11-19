/**
 * lib/data/demo-plan.ts · 허용 금형만으로 데모 계획 셀을 만든다 (순수 함수, DB 접근 없음)
 *
 * 실제 기준정보를 가져온 뒤 가상 계획 대신 화면 확인용으로 쓴다. 제품은 DB 에서 읽은 허용 금형만 쓰므로
 * 코드에 실제 값이 들어가지 않는다.
 *   - 호기마다 허용 제품을 순서대로 runDays 일씩 생산
 *   - 교체일은 호기 순번만큼 엇갈려, 하루 교체 수가 ceil(호기 수 / runDays) 를 넘지 않게 한다
 *   - 제품이 바뀌는 첫날만 교체유형(기본 BM), 수량은 비워 엔진이 Capa 로 계산하게 한다
 */
import type { ChangeoverKind, ISODate, PlanCell } from "../engine/types";

export interface DemoPlanInput {
  /** 정렬된 호기 목록 (sort_order 순) */
  lines: { id: string }[];
  /** 호기 id → 허용 제품 id (정렬된 순서) */
  allowedByLine: Map<string, string[]>;
  dates: ISODate[];
  runDays?: number;
  changeoverType?: ChangeoverKind;
}

export function buildDemoPlanCells(input: DemoPlanInput): PlanCell[] {
  const runDays = Math.max(1, input.runDays ?? 7);
  const ct = input.changeoverType ?? "BM";
  const cells: PlanCell[] = [];
  input.lines.forEach((line, lineIdx) => {
    const allowed = input.allowedByLine.get(line.id) ?? [];
    if (allowed.length === 0) return;
    const offset = lineIdx % runDays;
    let runNo = 0;
    let prev: string | null = null;
    input.dates.forEach((date, d) => {
      if (d > 0 && (d + offset) % runDays === 0) runNo++;
      const productId = allowed[runNo % allowed.length];
      cells.push({
        lineId: line.id,
        date,
        productId,
        qty: null,
        changeoverType: prev !== null && prev !== productId ? ct : "NONE",
      });
      prev = productId;
    });
  });
  return cells;
}
