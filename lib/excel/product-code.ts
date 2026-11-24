/**
 * lib/excel/product-code.ts · 제품명 정리와 제품코드 생성 규칙 (한 곳에 모음)
 *
 * 운용안 원본에는 제품코드가 없어서 제품명으로 코드를 만든다.
 * 나중에 회사 품번을 쓰게 되면 productCodeFor() 만 바꾸면 된다.
 *
 * 비교 규칙은 common.ts 의 normalizeName(NFC · 앞뒤 공백 제거 · 연속 공백 1칸 · 소문자)과 같다.
 * 저장용 이름은 대소문자를 그대로 두고 공백만 정리한다.
 */
import { createHash } from "node:crypto";
import { normalizeName } from "./common";

/** 해시 기반 제품코드 접두어 (Real Product) */
export const PRODUCT_CODE_PREFIX = "RP-";

/** 저장용 제품명: NFC · 앞뒤 공백 제거 · 연속 공백 1칸. 대소문자와 '#' 같은 기호는 원문 그대로 */
export function cleanProductName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * 제품명 → 제품코드. 'RP-' + SHA-1(normalizeName(이름)) 앞 8자리(대문자 16진수).
 * normalizeName 기준이라 공백·대소문자만 다른 이름은 같은 코드가 된다(계획표 셀 매칭 규칙과 동일).
 */
export function productCodeFor(name: string): string {
  const hex = createHash("sha1").update(normalizeName(name), "utf8").digest("hex");
  return `${PRODUCT_CODE_PREFIX}${hex.slice(0, 8).toUpperCase()}`;
}
