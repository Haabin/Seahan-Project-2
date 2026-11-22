/**
 * 수불표 품목 ↔ 생산계획 제품 자동 매칭 (순수 함수).
 * 품명이 완전히 같지 않아도 연결할 수 있게, 낱말 단위로 비교해 "제안"을 만든다. 확정은 사람이 한다.
 *
 * 규칙
 *  - 낱말로 나눈다: 공백 · _ · - · / · 괄호 · 쉼표 기준. '#' 은 버린다.
 *  - 숫자+단위는 숫자만 같아도 같은 낱말로 본다 ("1.5" = "1.5kg", "500" = "500ml").
 *    단위가 둘 다 있는데 다르면("300G" / "300ML") 절반만 맞은 것으로 치고, 자동으로 정하지 않고 후보로만 보여준다.
 *  - 색 이름은 한글·영문을 같은 것으로 본다 (적색 = RED, 노랑 = YELLOW, 골드 = GOLD …).
 *  - 제품의 숫자 낱말(용량·중량)이 품목에 없으면 다른 제품으로 본다 ("1.5L 사각" ≠ "1.65L 사각").
 *  - 점수 = 제품 낱말이 품목에 들어 있는 비율 × 0.7 + 품목 낱말이 제품에 들어 있는 비율 × 0.3
 *  - 낱말이 전부 맞으면 "자동 제안". 아니면 가장 높은 점수가 AUTO_SCORE 이상이고 2등과 MARGIN 이상 차이 나야 "자동 제안",
 *    CANDIDATE_SCORE 이상이면 "후보 여럿"(사람이 골라야 함), 그 밖은 "못 찾음".
 *  - "10/1일 생산~", "반 품(10/8일)" 처럼 윗 품목의 생산일·반품 구분으로 적힌 줄은 윗 품목과 같은 제품으로 제안한다.
 */

export const AUTO_SCORE = 0.75;
export const CANDIDATE_SCORE = 0.6;
/** 품목 낱말의 절반 이상이 제품에 있어야 자동으로 정한다 ("PE 5L 말통" 을 제품 "5L" 로 정하지 않게) */
export const AUTO_MIN_ITEM_COVER = 0.5;
export const MARGIN = 0.1;

const COLORS: Record<string, string> = {
  적색: "red", 레드: "red", 빨강: "red", red: "red",
  노랑: "yellow", 황색: "yellow", 옐로우: "yellow", yellow: "yellow",
  골드: "gold", 금색: "gold", gold: "gold",
  그린: "green", 녹색: "green", green: "green",
  블루: "blue", 청색: "blue", blue: "blue",
  아이보리: "ivory", ivory: "ivory",
  브라운: "brown", 갈색: "brown", brown: "brown",
  투명: "clear", cl: "clear", clear: "clear",
};

export interface MatchToken {
  raw: string;
  /** 숫자 낱말이면 숫자 부분 */
  num: string | null;
  unit: string;
}

export function matchTokens(name: string): MatchToken[] {
  const cleaned = name.normalize("NFC").toLowerCase().replace(/#/g, " ");
  const out: MatchToken[] = [];
  for (const part of cleaned.split(/[\s_\-/()[\],~·=]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+(?:\.\d+)?)([a-z가-힣%]*)$/);
    if (m) out.push({ raw: part, num: String(Number(m[1])), unit: m[2] });
    else out.push({ raw: COLORS[part] ?? part, num: null, unit: "" });
  }
  return out;
}

/** 1 = 같은 낱말, 0.5 = 숫자는 같은데 단위가 다름(300G / 300ML), 0 = 다름 */
function tokenMatch(a: MatchToken, b: MatchToken): number {
  if (a.num !== null || b.num !== null) {
    if (a.num === null || b.num === null || a.num !== b.num) return 0;
    return !a.unit || !b.unit || a.unit === b.unit ? 1 : 0.5;
  }
  return a.raw === b.raw ? 1 : 0;
}
const best = (t: MatchToken, others: MatchToken[]) => others.reduce((m, x) => Math.max(m, tokenMatch(t, x)), 0);

/** 0~1. 제품의 숫자 낱말이 품목에 없으면 0 */
export function matchScore(itemName: string, productName: string): number {
  const a = matchTokens(itemName);
  const b = matchTokens(productName);
  if (!a.length || !b.length) return 0;
  if (a.map((t) => t.raw).join(" ") === b.map((t) => t.raw).join(" ")) return 1;
  for (const t of b) if (t.num !== null && best(t, a) === 0) return 0;
  const bInA = b.reduce((sum, t) => sum + best(t, a), 0) / b.length;
  const aInB = a.reduce((sum, t) => sum + best(t, b), 0) / a.length;
  let score = bInA * 0.7 + aInB * 0.3;
  // 품목 이름의 대부분이 제품에 없는 낱말이면(제품 이름이 너무 짧은 경우) 자동으로 정하지 않는다
  if (aInB < AUTO_MIN_ITEM_COVER) score = Math.min(score, AUTO_SCORE - 0.05);
  // 단위가 다른 숫자가 끼어 있으면 자동으로 정하지 않고 사람이 고르게 한다
  if (b.some((t) => t.num !== null && best(t, a) === 0.5)) score = Math.min(score, AUTO_SCORE - 0.05);
  return Math.round(score * 1000) / 1000;
}

/** 윗 품목의 생산일·반품 구분으로 적힌 줄인가 ("10/1일 생산~", "8/10일~", "반 품(10/8일)") */
export function isSubRowName(name: string): boolean {
  const t = name.normalize("NFC").trim();
  return /^\d{1,2}\/\d{1,2}일/.test(t) || /^반\s*품/.test(t) || /^신형\s*라벨/.test(t);
}

export interface MatchItem {
  /** 품목 식별자 */
  key: string;
  name: string;
  /** 이미 연결된 제품 */
  productId: string | null;
}
export interface MatchProduct {
  id: string;
  name: string;
}
export interface MatchProposal {
  key: string;
  name: string;
  kind: "auto" | "candidates" | "parent";
  /** 제안하는 제품(가장 점수 높은 것) */
  productId: string;
  score: number;
  /** 점수 순 후보(최대 3개) */
  candidates: { productId: string; score: number }[];
}

export interface MatchResult {
  linked: number;
  proposals: MatchProposal[];
  /** 후보를 찾지 못한 품목 이름 */
  unmatched: string[];
}

/** 연결되지 않은 품목마다 제안을 만든다. items 는 표에 나오는 순서대로 */
export function proposeProductLinks(items: MatchItem[], products: MatchProduct[]): MatchResult {
  const result: MatchResult = { linked: 0, proposals: [], unmatched: [] };
  let parentProduct: string | null = null;
  for (const item of items) {
    const sub = isSubRowName(item.name);
    if (item.productId) {
      result.linked++;
      if (!sub) parentProduct = item.productId;
      continue;
    }
    if (sub) {
      if (parentProduct) result.proposals.push({ key: item.key, name: item.name, kind: "parent", productId: parentProduct, score: 1, candidates: [{ productId: parentProduct, score: 1 }] });
      else result.unmatched.push(item.name);
      continue;
    }
    const scored = products
      .map((p) => ({ productId: p.id, score: matchScore(item.name, p.name), name: p.name }))
      .filter((s) => s.score >= CANDIDATE_SCORE)
      .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, "ko"));
    if (!scored.length) {
      result.unmatched.push(item.name);
      parentProduct = null;
      continue;
    }
    const best = scored[0];
    const second = scored[1]?.score ?? 0;
    // 낱말이 전부 맞으면(1점) 2등과 차이가 작아도 자동, 아니면 2등과 충분히 벌어져야 자동
    const auto = best.score === 1 ? second < 1 : best.score >= AUTO_SCORE && best.score - second >= MARGIN;
    result.proposals.push({ key: item.key, name: item.name, kind: auto ? "auto" : "candidates", productId: best.productId, score: best.score, candidates: scored.slice(0, 3).map(({ productId, score }) => ({ productId, score })) });
    // 자동 제안만 아랫줄(생산일·반품 구분)의 기준으로 삼는다
    parentProduct = auto ? best.productId : null;
  }
  return result;
}
