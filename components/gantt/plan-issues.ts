import type { ProductSupplyRow, Violation } from "@/lib/engine/types";
import type { DraftException } from "@/lib/engine/draft";
import { EXCEPTION_GROUPS } from "@/components/gantt/exception-groups";
import { fmtInt, fmtMD } from "@/lib/format";

/**
 * 생산계획표 오른쪽 경고 패널과 확정 확인창이 함께 쓰는 문구.
 * 패널(plan-workspace)에 있던 문구를 그대로 옮겼다. 한 곳에서만 바꾼다.
 */
export function violationTitle(v: Violation) {
  switch (v.code) {
    case "MOLD_NOT_ALLOWED":
      return "허용되지 않은 금형";
    case "CHANGEOVER_LIMIT":
      return "교체 횟수 초과";
    case "DOWNTIME_ASSIGNED":
      return "가동 불가일 배치";
    case "CHANGEOVER_DEFAULTED":
      return "교체유형 미입력 · 기본값 적용";
    case "UNKNOWN_PRODUCT":
      return "기준정보에 없는 제품";
    case "OUTSIDE_FACTOR_TABLE":
      return "비가동 시간 기준표 밖";
  }
}

export const shortageTitle = (s: ProductSupplyRow) => `부족 · ${s.productName}`;
export const shortageBody = (s: ProductSupplyRow) => `${s.firstShortageDate ? fmtMD(s.firstShortageDate) : ""}부터 −${fmtInt(s.firstShortageQty)}본`;
export const safetyTitle = (s: ProductSupplyRow) => `안전재고 미달 · ${s.productName}`;
export const safetyBody = (s: ProductSupplyRow) => `${s.firstWarningDate ? fmtMD(s.firstWarningDate) : ""} · 안전재고 ${fmtInt(s.safetyStock)}`;

export type IssueKind = "error" | "shortage" | "safety" | "notice" | "draft";

export interface ConfirmIssue {
  kind: IssueKind;
  tone: "danger" | "warn";
  title: string;
  body: string;
}

export interface ConfirmSummary {
  counts: {
    errors: number;
    shortages: number;
    safety: number;
    notices: number;
    /** 초안 자동 생성의 확인 필요. 이 화면에서 자동 생성을 실행하지 않았으면 null */
    draft: number | null;
  };
  /** 오류 + 부족 = 경고 패널 머리글의 「경고 N건」 */
  warningsTotal: number;
  /** 모든 종류 합계 (확인 필요 포함) */
  total: number;
  /** 보여줄 항목 (앞에서부터 limit 개) */
  items: ConfirmIssue[];
  /** 잘려서 안 보이는 항목 수 → 「외 N건」 */
  hiddenCount: number;
}

export const CONFIRM_SUMMARY_LIMIT = 8;

/**
 * 확정 확인창 요약. 경고 패널이 이미 계산한 목록을 그대로 받아 세고 문구를 붙인다(다시 계산하지 않는다).
 * 순서는 패널과 같다: 오류 → 부족 → 안전재고 미달 → 주의, 그 뒤에 확인 필요(급한 종류 먼저).
 */
export function buildConfirmSummary(
  input: {
    errors: Violation[];
    shortages: ProductSupplyRow[];
    safetyWarnings: ProductSupplyRow[];
    notices: Violation[];
    draftExceptions: DraftException[] | null;
  },
  limit = CONFIRM_SUMMARY_LIMIT,
): ConfirmSummary {
  const order = new Map(EXCEPTION_GROUPS.map((g, i) => [g.code, i]));
  const tone = new Map(EXCEPTION_GROUPS.map((g) => [g.code, g.tone]));
  const title = new Map(EXCEPTION_GROUPS.map((g) => [g.code, g.title]));
  const draft = input.draftExceptions
    ? [...input.draftExceptions].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
    : [];

  const all: ConfirmIssue[] = [
    ...input.errors.map((v): ConfirmIssue => ({ kind: "error", tone: "danger", title: violationTitle(v), body: v.message })),
    ...input.shortages.map((s): ConfirmIssue => ({ kind: "shortage", tone: "danger", title: shortageTitle(s), body: shortageBody(s) })),
    ...input.safetyWarnings.map((s): ConfirmIssue => ({ kind: "safety", tone: "warn", title: safetyTitle(s), body: safetyBody(s) })),
    ...input.notices.map((v): ConfirmIssue => ({ kind: "notice", tone: "warn", title: violationTitle(v), body: v.message })),
    ...draft.map((e): ConfirmIssue => ({ kind: "draft", tone: tone.get(e.code) ?? "warn", title: `확인 필요 · ${title.get(e.code) ?? e.code}`, body: e.message })),
  ];
  const shown = all.slice(0, Math.max(0, limit));
  return {
    counts: {
      errors: input.errors.length,
      shortages: input.shortages.length,
      safety: input.safetyWarnings.length,
      notices: input.notices.length,
      draft: input.draftExceptions ? input.draftExceptions.length : null,
    },
    warningsTotal: input.errors.length + input.shortages.length,
    total: all.length,
    items: shown,
    hiddenCount: all.length - shown.length,
  };
}
