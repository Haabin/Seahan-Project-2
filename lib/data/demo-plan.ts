/**
 * lib/data/demo-plan.ts · 허용 금형만으로 데모 계획 셀을 만든다 (순수 함수, DB 접근 없음)
 *
 * 실제 기준정보를 가져온 뒤 가상 계획 대신 화면 확인용으로 쓴다. 제품은 DB 에서 읽은 허용 금형만 쓰므로
 * 코드에 실제 값이 들어가지 않는다.
 *   - 호기마다 허용 제품을 순서대로 runDays 일씩 생산
 *   - 교체일은 호기 순번만큼 엇갈려, 하루 교체 수가 ceil(호기 수 / runDays) 를 넘지 않게 한다
 *   - 다운타임 날짜에는 셀을 만들지 않는다 (가동 불가일 배치 경고 방지)
 *   - 제품이 바뀌는 첫날의 교체유형은 changeoverPattern 을 호기 순번만큼 밀어 가며 쓴다
 *     (기본 BM → FULL → 미입력. 미입력은 엔진이 기본 교체유형을 적용해 'B/M?' 로 보인다)
 *   - 엔진은 전날 셀과만 비교하므로, 다운타임 바로 다음 날 교체는 미입력 대신 명시 유형을 넣어 배지가 사라지지 않게 한다
 *   - 수량은 비워 엔진이 Capa 로 계산하게 한다
 */
import type { ChangeoverType, ISODate, PlanCell } from "../engine/types";

export interface DemoPlanInput {
  /** 정렬된 호기 목록 (sort_order 순) */
  lines: { id: string }[];
  /** 호기 id → 허용 제품 id (정렬된 순서) */
  allowedByLine: Map<string, string[]>;
  dates: ISODate[];
  runDays?: number;
  /** 가동 불가 기간 (양 끝 포함) */
  downtimes?: { lineId: string; startDate: ISODate; endDate: ISODate }[];
  /** 제품이 바뀔 때 쓰는 교체유형 순서. 'NONE' = 미입력 */
  changeoverPattern?: ChangeoverType[];
}

export const DEFAULT_DEMO_CHANGEOVER_PATTERN: ChangeoverType[] = ["BM", "FULL", "NONE"];

export function isDowntimeDate(downtimes: DemoPlanInput["downtimes"], lineId: string, date: ISODate): boolean {
  return (downtimes ?? []).some((d) => d.lineId === lineId && d.startDate <= date && date <= d.endDate);
}

export function buildDemoPlanCells(input: DemoPlanInput): PlanCell[] {
  const runDays = Math.max(1, input.runDays ?? 7);
  const pattern = input.changeoverPattern?.length ? input.changeoverPattern : DEFAULT_DEMO_CHANGEOVER_PATTERN;
  const explicit = pattern.find((t) => t !== "NONE") ?? "BM";
  const cells: PlanCell[] = [];
  input.lines.forEach((line, lineIdx) => {
    const allowed = input.allowedByLine.get(line.id) ?? [];
    if (allowed.length === 0) return;
    const offset = lineIdx % runDays;
    let runNo = 0;
    let changeNo = 0;
    let prev: string | null = null;
    let prevDayFilled = false;
    input.dates.forEach((date, d) => {
      if (d > 0 && (d + offset) % runDays === 0) runNo++;
      if (isDowntimeDate(input.downtimes, line.id, date)) {
        prevDayFilled = false;
        return;
      }
      const productId = allowed[runNo % allowed.length];
      let changeoverType: ChangeoverType = "NONE";
      if (prev !== null && prev !== productId) {
        changeoverType = pattern[(lineIdx + changeNo) % pattern.length];
        if (changeoverType === "NONE" && !prevDayFilled) changeoverType = explicit;
        changeNo++;
      }
      cells.push({ lineId: line.id, date, productId, qty: null, changeoverType });
      prev = productId;
      prevDayFilled = true;
    });
  });
  return cells;
}
