import { describe, expect, it } from "vitest";
import { emptyLineSpec, LINE_SPEC_FIELDS, lineSpecFromRow, lineSpecInputSchema, lineSpecToRow } from "@/lib/data/line-specs";
import { buildSeedSql, generateDataset, generateLineSpecs } from "../../../scripts/make-fake-data";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("설비 상세 입력 검증 (line_specs)", () => {
  it("앞뒤 공백 제거, 빈 문자열은 null", () => {
    const r = lineSpecInputSchema.parse({
      lineId: UUID,
      maker: "  가상기계 A ",
      model: "",
      installedOn: "",
      installedNote: null,
      installSource: "   ",
      takeOut: null,
      hotRunner: "가상 H/R 32cavity\n인접 호기 호환",
      cavityNote: null,
      allowedProductsRaw: null,
      memo: null,
    });
    expect(r.maker).toBe("가상기계 A");
    expect(r.model).toBeNull();
    expect(r.installedOn).toBeNull();
    expect(r.installSource).toBeNull();
    expect(r.hotRunner).toBe("가상 H/R 32cavity\n인접 호기 호환");
  });

  it("도입일은 YYYY-MM-DD, 설비 id는 uuid", () => {
    const base = Object.fromEntries(LINE_SPEC_FIELDS.map(([k]) => [k, null]));
    expect(lineSpecInputSchema.safeParse({ ...base, lineId: UUID, installedOn: "2025-01-15" }).success).toBe(true);
    expect(lineSpecInputSchema.safeParse({ ...base, lineId: UUID, installedOn: "25.01월" }).success).toBe(false);
    expect(lineSpecInputSchema.safeParse({ ...base, lineId: "PET1" }).success).toBe(false);
  });

  it("너무 긴 글자는 거부", () => {
    const base = Object.fromEntries(LINE_SPEC_FIELDS.map(([k]) => [k, null]));
    expect(lineSpecInputSchema.safeParse({ ...base, lineId: UUID, maker: "가".repeat(101) }).success).toBe(false);
  });

  it("DB 행 ↔ 화면 값 변환이 서로 맞음", () => {
    const parsed = lineSpecInputSchema.parse({
      ...Object.fromEntries(LINE_SPEC_FIELDS.map(([k]) => [k, null])),
      lineId: UUID,
      maker: "가상기계 B",
      installedOn: "2024-03-02",
      cavityNote: "24 / 32",
    });
    const row = lineSpecToRow(parsed);
    const back = lineSpecFromRow({ ...row, updated_at: null });
    expect(back).toEqual({ ...emptyLineSpec(UUID), maker: "가상기계 B", installedOn: "2024-03-02", cavityNote: "24 / 32" });
  });
});

describe("가상 설비 상세 데이터 (NFR-01: 실제 값 없음)", () => {
  const ds = generateDataset();

  it("모든 설비에 1건씩, PET1~18 포함", () => {
    expect(ds.lineSpecs).toHaveLength(ds.lines.length);
    const ids = new Set(ds.lineSpecs.map((s) => s.lineId));
    for (const l of ds.lines.filter((x) => x.isPlanTarget)) expect(ids.has(l.id)).toBe(true);
  });

  it("제조사·모델·도입처·취출·H/R 은 모두 가상 이름", () => {
    for (const s of ds.lineSpecs) {
      expect(s.maker).toMatch(/^가상/);
      expect(s.model).toMatch(/^V[A-F]-/);
      expect(s.installSource).toMatch(/^가상/);
      if (s.takeOut) expect(s.takeOut).toMatch(/^가상/);
      if (s.hotRunner) expect(s.hotRunner).toMatch(/^가상/);
    }
  });

  it("B열 원문은 가상 제품명으로만 구성, 도입일은 날짜 또는 원문 메모 중 하나", () => {
    const names = new Set(ds.products.map((p) => p.name));
    for (const s of ds.lineSpecs) {
      for (const n of (s.allowedProductsRaw ?? "").split(", ").filter(Boolean)) expect(names.has(n)).toBe(true);
      expect((s.installedOn === null) !== (s.installedNote === null)).toBe(true);
    }
  });

  it("결정적: 다시 만들어도 같은 결과", () => {
    expect(generateLineSpecs(ds.lines, ds.products, ds.allowedMolds)).toEqual(ds.lineSpecs);
  });

  it("seed.sql 에 line_specs 섹션이 재실행 가능한 형태로 들어감", () => {
    const sql = buildSeedSql(ds);
    expect(sql).toContain(`-- ---------- line_specs (${ds.lineSpecs.length}) ----------`);
    expect(sql).toContain("on conflict (line_id) do update set maker = excluded.maker");
    // 기존 섹션 뒤, 마지막 '-- 끝' 앞
    expect(sql.indexOf("line_specs (")).toBeGreaterThan(sql.indexOf("monthly_operation_plan ("));
    expect(sql.trimEnd().endsWith("-- 끝")).toBe(true);
  });
});
