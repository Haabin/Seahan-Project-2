/**
 * FR-01 제품배치 운용안 가져오기 테스트
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFakeMasterBuffer, generateDataset } from "../../../scripts/make-fake-data";
import { parseMasterWorkbook } from "../../../lib/excel";

describe("FR-01 parseMasterWorkbook · 가상 운용안", () => {
  const ds = generateDataset();

  async function load() {
    const path = join(process.cwd(), "data", "fake", ds.files.master);
    return existsSync(path) ? readFileSync(path) : await buildFakeMasterBuffer(ds);
  }

  it("FR-01 (호기 × 허용 제품) 행 수와 월 열을 읽는다", async () => {
    const r = await parseMasterWorkbook(await load());
    expect(r.sheetName).toBe("운용안");
    expect(r.rows).toHaveLength(ds.allowedMolds.length);
    expect(r.months).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(r.warnings).toEqual([]);
  });

  it("FR-01 호기 라벨은 코드로, 숫자 열은 number 로", async () => {
    const r = await parseMasterWorkbook(await load());
    const first = r.rows[0];
    expect(first.lineCode).toBe("PET1");
    const p = ds.products.find((x) => x.code === first.productCode)!;
    expect(first.productName).toBe(p.name);
    expect(first.cavity).toBe(p.cavity);
    expect(first.packUnit).toBe(p.packUnit);
    expect(first.weightG).toBeCloseTo(p.preformWeightG, 3);
    expect(first.safetyStock).toBe(p.safetyStock);
    expect(typeof first.dailyCapa).toBe("number");
    const pet1 = ds.lines.find((l) => l.code === "PET1")!;
    const capa = ds.capacities.find((c) => c.lineId === pet1.id && c.productId === p.id)?.dailyCapa ?? p.defaultDailyCapa;
    expect(first.dailyCapa).toBe(capa);
    expect(new Set(r.rows.map((x) => x.lineCode)).size).toBe(18);
  });

  it("FR-01 월별 물량·가동일수는 monthly_operation_plan 과 1:1", async () => {
    const r = await parseMasterWorkbook(await load());
    const total = r.rows.reduce((n, row) => n + row.monthly.length, 0);
    expect(total).toBe(ds.monthlyPlans.length);
    const lineByCode = new Map(ds.lines.map((l) => [l.code, l.id]));
    const productByCode = new Map(ds.products.map((p) => [p.code, p.id]));
    for (const row of r.rows) {
      for (const m of row.monthly) {
        const want = ds.monthlyPlans.find((x) => x.lineId === lineByCode.get(row.lineCode) && x.productId === productByCode.get(row.productCode) && x.yearMonth === m.yearMonth);
        expect(want, `${row.lineCode} ${row.productCode} ${m.yearMonth}`).toBeDefined();
        expect(m.qty).toBe(want!.qty);
        expect(m.workingDays).toBe(want!.workingDays);
      }
    }
  });
});
