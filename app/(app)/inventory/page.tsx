import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { isYearMonth, listStockMonths, loadStockMonth } from "@/lib/data/stock";
import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import { PageHeader } from "@/components/ui";

/** 오늘(KST)의 연월 */
function currentYearMonth(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 재고현황: 제품수불표(월 단위)를 화면에서 고치고, 엑셀로 올리고 내려받는다 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ ym?: string; notice?: string; t?: string }> }) {
  const session = await requireSession();
  const { ym, notice, t } = await searchParams;
  const db = await createSupabaseServer();
  const months = await listStockMonths(db);
  const yearMonth = isYearMonth(ym) ? ym : (months[0] ?? currentYearMonth());

  const [data, { data: products }] = await Promise.all([loadStockMonth(db, yearMonth), db.from("products").select("id, name, safety_stock").order("name")]);

  return (
    <>
      <PageHeader title="재고현황" sub="제품수불표 · 품목별 기초재고와 일자별 생산·출고. 현재고는 수급 검증의 시작 재고로도 쓰입니다." />
      <InventoryWorkspace
        key={`${yearMonth}:${data.editedAt ?? ""}:${data.rows.length}:${t ?? ""}`}
        yearMonth={yearMonth}
        months={months}
        rows={data.rows}
        products={(products ?? []).map((p) => ({ id: p.id, name: p.name, safetyStock: Number(p.safety_stock ?? 0) }))}
        canWrite={canWrite(session.role)}
        uploadedAt={data.uploadedAt}
        uploadFilename={data.uploadFilename}
        editedAt={data.editedAt}
        notice={notice ? notice.slice(0, 200) : null}
      />
    </>
  );
}
