/**
 * FR-01 현행 운용안 원본 양식 파서 테스트 (가상 엑셀)
 * 원본 양식의 구조만 흉내 낸다: 2줄 헤더, 호기·설비는 묶음 첫 행에만, 소계·합계 행, 수식 결과 Capa,
 * 제품명 공백·'#', 묶음 표기, 같은 제품이 두 호기에 있는 경우. 값은 모두 가상이다.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildDemoPlanCells } from "../../../lib/data/demo-plan";
import { BUNDLE_NOTE, cleanProductName, parseOperationPlanWorkbook, productCodeFor, resolveEquipment, workbookToBuffer } from "../../../lib/excel";
import { buildSeedSql, generateDataset } from "../../../scripts/make-fake-data";

const RULES = { prefixes: { "X_": "가상기계" }, aliases: { "50Q": { maker: "가상기계2", model: "QQ-50Q" } } };

type Cell = string | number | { formula: string; result: number } | null;

async function buildFakeOperationPlan(opts: { sheetName?: string; extraSheetFirst?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  if (opts.extraSheetFirst) wb.addWorksheet("다른 시트").getCell("A1").value = "관계없는 시트";
  const ws = wb.addWorksheet(opts.sheetName ?? "1. 가상-1stage");
  ws.getCell("A2").value = "■ 가상 제품배치 운용안";
  const head1 = ["구분", "호기", "생산설비", "분류", "제품명", "포장", "포장", "박스", "일일", "INJ", "CAV", "Capa", null, "1월", "1월"];
  const head2 = ["구분", "호기", "생산설비", "분류", "제품명", "수량", "박스/p", "일사용량", "PT수", "INJ", "CAV", "천본/일", null, "수량", "가동일수"];
  head1.forEach((v, c) => { if (v !== null) ws.getRow(5).getCell(c + 1).value = v; });
  head2.forEach((v, c) => { if (v !== null) ws.getRow(6).getCell(c + 1).value = v; });

  // [A, B 호기, C 설비, D 분류, E 제품명, F 포장수량, G 박스/p, H, I, J INJ, K CAV, L Capa, M, N 1월 수량]
  const rows: Cell[][] = [
    [null, 1, "X_100A", "가상", "# 가상 1L 원형", 100, 12, null, null, 40, 4, { formula: "1000*0.95", result: 950 }, null, 12345],
    [null, null, null, "가상", "  # 가상 2L   원형 ", 60, 12, null, null, 80, 3, 700, null, 1],
    [null, null, null, null, "가상 묶음 10종", 70, 16, null, null, 70, 4, { formula: "86400/20*3*0.9", result: 11664 }, null, 1],
    [1, "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", null, { formula: "SUM(N7:N9)", result: 12347 }],
    [null, 2, "50Q", null, "가상 소스 300", 200, 16, null, null, 30, 6, { formula: "1299.5*0.95", result: 1234.525 }, null, 5],
    [null, null, null, null, "# 가상 1L 원형", 100, 12, null, null, 40, 4, 800, null, 5],
    [2, "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계"],
    [null, 3, null, null, "가상 컵", 300, 16, null, null, 20, 8, 30000],
    [3, "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계", "소계"],
    [],
    ["가상 1 합계", "가상 1 합계", "가상 1 합계", "가상 1 합계", "가상 1 합계"],
  ];
  rows.forEach((values, i) => {
    const row = ws.getRow(7 + i);
    values.forEach((v, c) => {
      if (v !== null && v !== undefined) row.getCell(c + 1).value = v as ExcelJS.CellValue;
    });
  });
  return workbookToBuffer(wb);
}

describe("FR-01 parseOperationPlanWorkbook · 현행 운용안 원본 양식 (가상)", () => {
  it("2줄 헤더를 찾고, 소계·합계·빈 행을 건너뛴다", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    expect(r.sheetName).toBe("1. 가상-1stage");
    expect(r.headerRows).toEqual([5, 6]);
    expect(r.capaHeader).toBe("Capa 천본/일");
    expect(r.rows).toHaveLength(6);
    expect(r.skipped).toEqual({ subtotal: 3, total: 1, blank: 1 });
  });

  it("호기 번호와 생산설비를 묶음 아래 행에 채운다 (1 → PET1)", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    expect(r.rows.map((x) => x.lineCode)).toEqual(["PET1", "PET1", "PET1", "PET2", "PET2", "PET3"]);
    expect(r.rows.map((x) => x.equipmentRaw)).toEqual(["X_100A", "X_100A", "X_100A", "50Q", "50Q", null]);
    expect(r.warnings.some((w) => w.includes("PET3") && w.includes("생산설비가 비어"))).toBe(true);
  });

  it("Capa 는 수식 계산값을 내림하고, 월별 수량·INJ 는 읽지 않는다", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    const [a, , bundle, sauce] = r.rows;
    expect(a.dailyCapaRaw).toBe(950);
    expect(a.dailyCapa).toBe(950);
    expect(bundle.dailyCapa).toBe(11664);
    expect(sauce.dailyCapaRaw).toBeCloseTo(1234.525, 6);
    expect(sauce.dailyCapa).toBe(1234);
    expect(a.packUnit).toBe(100);
    expect(a.cavity).toBe(4);
    expect(Object.keys(a)).not.toContain("inj");
  });

  it("제품명: '#'은 그대로, 앞뒤 공백 제거·겹친 공백 1칸, 코드는 이름 해시", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    const second = r.rows[1];
    expect(second.productNameRaw).toBe("  # 가상 2L   원형 ");
    expect(second.productName).toBe("# 가상 2L 원형");
    expect(second.productCode).toBe(productCodeFor("# 가상 2L 원형"));
    expect(r.rows[0].productName.startsWith("#")).toBe(true);
  });

  it("같은 제품이 두 호기에 있으면 제품 1개, 기본 Capa 는 호기별 최솟값", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    expect(r.products).toHaveLength(5);
    const shared = r.products.find((p) => p.name === "# 가상 1L 원형")!;
    expect(shared.lineCodes).toEqual(["PET1", "PET2"]);
    expect(shared.defaultDailyCapa).toBe(800);
    expect(r.products.find((p) => p.name === "가상 소스 300")!.defaultDailyCapa).toBe(1234);
  });

  it("'10종' 같은 묶음 표기는 제품 1개로 두고 표시한다", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    const bundles = r.products.filter((p) => p.bundle);
    expect(bundles.map((p) => p.name)).toEqual(["가상 묶음 10종"]);
    expect(BUNDLE_NOTE).toBe("묶음 표기, 팀장님 확인 필요");
  });

  it("설비 규칙: 접두어는 제조사로 바꾸고 떼며, 별칭은 저장 모델명으로, 원문은 memo 에", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan(), { equipment: RULES });
    expect(r.lineSpecs).toEqual([
      { lineCode: "PET1", equipmentRaw: "X_100A", maker: "가상기계", model: "100A", memo: "생산설비 원문: X_100A" },
      { lineCode: "PET2", equipmentRaw: "50Q", maker: "가상기계2", model: "QQ-50Q", memo: "생산설비 원문: 50Q" },
      { lineCode: "PET3", equipmentRaw: null, maker: null, model: null, memo: null },
    ]);
  });

  it("설비 규칙이 없으면 제조사를 비우고 경고한다", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan());
    expect(r.lineSpecs[0]).toMatchObject({ maker: null, model: "X_100A" });
    expect(r.warnings.some((w) => w.includes("X_100A") && w.includes("제조사 규칙"))).toBe(true);
    expect(resolveEquipment("Y_1", RULES)).toEqual({ maker: null, model: "Y_1", matched: false });
  });

  it("시트 이름을 주지 않으면 헤더가 있는 첫 시트를 찾는다", async () => {
    const r = await parseOperationPlanWorkbook(await buildFakeOperationPlan({ sheetName: "가상 공정", extraSheetFirst: true }));
    expect(r.sheetName).toBe("가상 공정");
    expect(r.rows).toHaveLength(6);
    const missing = await parseOperationPlanWorkbook(await buildFakeOperationPlan(), { sheetName: "없는 시트" });
    expect(missing.rows).toEqual([]);
    expect(missing.warnings[0]).toContain("없는 시트");
  });
});

describe("제품코드 규칙 (lib/excel/product-code.ts)", () => {
  it("'RP-' + 16진수 8자리, 공백·대소문자만 다른 이름은 같은 코드", () => {
    const code = productCodeFor("# 가상 1L 원형");
    expect(code).toMatch(/^RP-[0-9A-F]{8}$/);
    expect(productCodeFor("  #  가상 1l 원형 ")).toBe(code);
    expect(productCodeFor("# 가상 1L 사각")).not.toBe(code);
    expect(cleanProductName(" A  b ")).toBe("A b");
  });
});

describe("데모 계획 (lib/data/demo-plan.ts)", () => {
  const lines = Array.from({ length: 18 }, (_, i) => ({ id: `L${i + 1}` }));
  const allowedByLine = new Map(lines.map((l, i) => [l.id, i === 8 ? ["P-only"] : i === 17 ? [] : ["P-a", "P-b", "P-c"]]));
  const dates = Array.from({ length: 15 }, (_, i) => `2026-11-${String(19 + i > 30 ? 19 + i - 30 : 19 + i).padStart(2, "0")}`);

  it("허용 제품만 쓰고, 허용 금형이 없는 호기는 비운다", () => {
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates });
    expect(cells).toHaveLength(17 * 15);
    for (const c of cells) expect(allowedByLine.get(c.lineId)).toContain(c.productId);
    expect(cells.every((c) => c.qty === null)).toBe(true);
  });

  it("제품이 바뀌는 첫날만 BM, 하루 교체 수는 3 이하", () => {
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates });
    for (const l of lines) {
      const mine = cells.filter((c) => c.lineId === l.id);
      mine.forEach((c, i) => {
        const changed = i > 0 && mine[i - 1].productId !== c.productId;
        expect(c.changeoverType).toBe(changed ? "BM" : "NONE");
      });
    }
    for (const d of dates) expect(cells.filter((c) => c.date === d && c.changeoverType !== "NONE").length).toBeLessThanOrEqual(3);
    expect(cells.filter((c) => c.lineId === "L9").every((c) => c.changeoverType === "NONE")).toBe(true);
  });
});

describe("seed.sql 실제 기준정보 보호 가드", () => {
  it("첫머리에서 master_source = real 이면 중단하고, 끝에서 fake 로 표시한다", () => {
    const sql = buildSeedSql(generateDataset());
    const guard = sql.indexOf("current_setting('app.seed_force', true)");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(sql.indexOf("insert into lines"));
    expect(sql).toContain(`'master_source', '"fake"'::jsonb`);
  });
});
