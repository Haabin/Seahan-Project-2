/**
 * FR-07 제약 검사.
 * ① 허용 금형 밖 배치  ② 공장 단위 하루 교체 횟수 초과  ③ 가동 불가일 배치
 * 주의: 교체유형 기본값 적용, 기준정보에 없는 제품
 */
import type { CellResult, EngineInput, ISODate, Violation, ViolationCode } from "./types";
import type { ProductionIndex } from "./production";
import { buildProductionIndex, CHANGEOVER_LABEL } from "./production";
import { shortDate } from "./calendar";

function addCode(cell: CellResult, code: ViolationCode): void {
  if (!cell.violations.includes(code)) cell.violations.push(code);
}

/** 셀 결과를 바탕으로 제약 위반 목록을 만들고 각 셀의 violations 를 채운다 (셀을 직접 수정) */
export function checkConstraints(
  input: EngineInput,
  cells: CellResult[],
  index: ProductionIndex = buildProductionIndex(input),
): Violation[] {
  const violations: Violation[] = [];

  const allowed = new Set<string>();
  for (const m of input.allowedMolds) allowed.add(`${m.lineId}|${m.productId}`);

  // 공장별·날짜별 교체 셀 모음
  const changeoverCells = new Map<string, CellResult[]>(); // key = factoryCode|date

  for (const cell of cells) {
    const line = index.lineById.get(cell.lineId);
    const lineName = line?.name ?? cell.lineId;
    const dateLabel = shortDate(cell.date);
    const product = cell.productId ? index.productById.get(cell.productId) : undefined;
    const productLabel = cell.productName ?? cell.productId ?? "";

    if (cell.productId != null) {
      // 기준정보에 없는 제품
      if (!product) {
        addCode(cell, "UNKNOWN_PRODUCT");
        violations.push({
          code: "UNKNOWN_PRODUCT",
          severity: "notice",
          lineId: cell.lineId,
          date: cell.date,
          productId: cell.productId,
          message: `${lineName} ${dateLabel}: 기준정보에 없는 제품(${cell.productId})`,
        });
      }

      // ① 허용 금형
      if (product && !allowed.has(`${cell.lineId}|${cell.productId}`)) {
        addCode(cell, "MOLD_NOT_ALLOWED");
        violations.push({
          code: "MOLD_NOT_ALLOWED",
          severity: "error",
          lineId: cell.lineId,
          date: cell.date,
          productId: cell.productId,
          message: `${lineName} ${dateLabel}: 허용되지 않은 금형(${productLabel})`,
        });
      }

      // ③ 가동 불가일 배치
      if (cell.isDowntime) {
        addCode(cell, "DOWNTIME_ASSIGNED");
        violations.push({
          code: "DOWNTIME_ASSIGNED",
          severity: "error",
          lineId: cell.lineId,
          date: cell.date,
          productId: cell.productId,
          message: `${lineName} ${dateLabel}: 가동 불가일에 제품 배치(${productLabel})`,
        });
      }
    }

    // 교체유형 기본값 적용 주의
    if (cell.changeoverDefaulted) {
      addCode(cell, "CHANGEOVER_DEFAULTED");
      const label = CHANGEOVER_LABEL[input.settings.defaultChangeoverType];
      violations.push({
        code: "CHANGEOVER_DEFAULTED",
        severity: "notice",
        lineId: cell.lineId,
        date: cell.date,
        productId: cell.productId,
        message: `${lineName} ${dateLabel}: 제품이 바뀌었으나 교체유형 미입력 → 기본값(${label}) 적용`,
        detail: { defaultChangeoverType: input.settings.defaultChangeoverType },
      });
    }

    // ② 교체 횟수 집계 (가동 불가일은 교체로 세지 않음)
    if (cell.effectiveChangeover !== "NONE" && !cell.isDowntime && line) {
      const key = `${line.factoryCode}|${cell.date}`;
      const arr = changeoverCells.get(key);
      if (arr) arr.push(cell);
      else changeoverCells.set(key, [cell]);
    }
  }

  const limit = input.settings.dailyChangeoverLimit;
  const limitKeys = Array.from(changeoverCells.keys()).sort();
  for (const key of limitKeys) {
    const list = changeoverCells.get(key) as CellResult[];
    if (list.length <= limit) continue;
    const sep = key.indexOf("|");
    const factoryCode = key.slice(0, sep);
    const date: ISODate = key.slice(sep + 1);
    for (const c of list) addCode(c, "CHANGEOVER_LIMIT");
    violations.push({
      code: "CHANGEOVER_LIMIT",
      severity: "error",
      lineId: null,
      date,
      productId: null,
      message: `${factoryCode} ${shortDate(date)}: 하루 교체 ${list.length}회 (한도 ${limit}회 초과)`,
      detail: { count: list.length, limit, factoryCode },
    });
  }

  return violations;
}
