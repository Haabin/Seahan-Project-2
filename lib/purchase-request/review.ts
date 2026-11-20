import type { PurchaseRow } from "./normalize";
import products from "./products.json";

const productCodes = new Set(products.map(product => product.code));

export function reviewErrors(rows: PurchaseRow[], customer: string): string[] {
  const errors: string[] = [];
  if (rows.length === 0 || rows.length > 5000)
    errors.push("품목은 1~5,000행이어야 합니다.");
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.reviewReason) errors.push(`${i+1}행 · ${r.reviewReason}`);
    if (r.productCode.trim() && !productCodes.has(r.productCode.trim()))
      errors.push(`${i + 1}행 · 미등록 품번을 확인하세요.`);
    const missing = [
      !r.productCode.trim() && "품번",
      !r.productName.trim() && "품명",
      !(r.customer.trim() || customer.trim()) && "거래처",
    ].filter(Boolean);
    if (missing.length) errors.push(`${i + 1}행 · ${missing.join(", ")} 누락`);
    if (!Number.isFinite(r.quantity) || Number(r.quantity) <= 0)
      errors.push(`${i + 1}행 · 수량은 양수로 입력하세요.`);
    else if (!Number.isSafeInteger(r.quantity) || !["EA","본","개",""].includes(r.unit.trim().toUpperCase()))
      errors.push(`${i + 1}행 · 발주수량을 정수 EA(본)로 입력하세요.`);
    const date = new Date(r.requestedDate + "T00:00:00Z");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(r.requestedDate) ||
      !Number.isFinite(+date) ||
      date.toISOString().slice(0, 10) !== r.requestedDate
    )
      errors.push(`${i + 1}행 · 납기일을 확인하세요.`);
    const key = JSON.stringify([
      r.productCode.trim(),
      r.productName.trim(),
      r.quantity,
      r.unit.trim(),
      r.requestedDate,
      r.customer.trim() || customer.trim(),
      r.destination || "", r.condition || "", r.note.trim(),
    ]);
    if (seen.has(key))
      errors.push(`${i + 1}행 · ${seen.get(key)}행과 같은 품목입니다.`);
    seen.set(key, i + 1);
  });
  return errors;
}
