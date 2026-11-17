/**
 * 설비 상세 정보 (line_specs, 0003_line_specs.sql).
 * 엔진 계산에는 쓰지 않는 표시·관리용 기준정보.
 */
import { z } from "zod";

export interface LineSpec {
  lineId: string;
  maker: string | null; // 제조사
  model: string | null; // 모델
  installedOn: string | null; // 도입일 'YYYY-MM-DD'
  installedNote: string | null; // 도입 원문
  installSource: string | null; // 도입처
  takeOut: string | null; // 취출
  hotRunner: string | null; // H/R
  cavityNote: string | null; // 캐비티
  allowedProductsRaw: string | null; // B열 원문
  memo: string | null;
  updatedAt: string | null;
}

/** 편집 가능한 필드 (화면 라벨 순서 = 표시 순서) */
export const LINE_SPEC_FIELDS = [
  ["maker", "제조사"],
  ["model", "모델"],
  ["installedOn", "도입일"],
  ["installedNote", "도입 메모"],
  ["installSource", "도입처"],
  ["takeOut", "취출"],
  ["hotRunner", "H/R"],
  ["cavityNote", "캐비티"],
  ["allowedProductsRaw", "생산 가능 제품 (B열 원문)"],
  ["memo", "메모"],
] as const satisfies readonly (readonly [keyof LineSpec, string])[];

const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .nullable()
    .transform((s) => (s ? s : null));

export const lineSpecInputSchema = z.object({
  lineId: z.string().uuid(),
  maker: text(100),
  model: text(100),
  installedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "도입일은 YYYY-MM-DD 형식")
    .nullable()
    .or(z.literal("").transform(() => null)),
  installedNote: text(200),
  installSource: text(100),
  takeOut: text(200),
  hotRunner: text(500),
  cavityNote: text(500),
  allowedProductsRaw: text(2000),
  memo: text(2000),
});
export type LineSpecInput = z.input<typeof lineSpecInputSchema>;

interface LineSpecRow {
  line_id: string;
  maker: string | null;
  model: string | null;
  installed_on: string | null;
  installed_note: string | null;
  install_source: string | null;
  take_out: string | null;
  hot_runner: string | null;
  cavity_note: string | null;
  allowed_products_raw: string | null;
  memo: string | null;
  updated_at: string | null;
}

export function lineSpecFromRow(r: LineSpecRow): LineSpec {
  return {
    lineId: r.line_id,
    maker: r.maker,
    model: r.model,
    installedOn: r.installed_on,
    installedNote: r.installed_note,
    installSource: r.install_source,
    takeOut: r.take_out,
    hotRunner: r.hot_runner,
    cavityNote: r.cavity_note,
    allowedProductsRaw: r.allowed_products_raw,
    memo: r.memo,
    updatedAt: r.updated_at,
  };
}

export function lineSpecToRow(s: z.output<typeof lineSpecInputSchema>) {
  return {
    line_id: s.lineId,
    maker: s.maker,
    model: s.model,
    installed_on: s.installedOn,
    installed_note: s.installedNote,
    install_source: s.installSource,
    take_out: s.takeOut,
    hot_runner: s.hotRunner,
    cavity_note: s.cavityNote,
    allowed_products_raw: s.allowedProductsRaw,
    memo: s.memo,
  };
}

export function emptyLineSpec(lineId: string): LineSpec {
  return {
    lineId,
    maker: null,
    model: null,
    installedOn: null,
    installedNote: null,
    installSource: null,
    takeOut: null,
    hotRunner: null,
    cavityNote: null,
    allowedProductsRaw: null,
    memo: null,
    updatedAt: null,
  };
}
