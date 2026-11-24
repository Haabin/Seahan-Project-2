import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth/session";
import { isYearMonth, loadStockMonth, ymRange } from "@/lib/data/stock";
import { buildStockLedgerWorkbook, stockLedgerFileName } from "@/lib/excel/stock-ledger";

export const runtime = "nodejs";

/** 제품수불표 내려받기 (원본과 같은 레이아웃, 파생값은 엑셀 수식). ?ym=2026-11 · 조회 권한도 가능 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const ym = new URL(req.url).searchParams.get("ym");
  if (!isYearMonth(ym)) return NextResponse.json({ error: "ym=YYYY-MM 이 필요합니다" }, { status: 400 });

  const db = await createSupabaseServer();
  const data = await loadStockMonth(db, ym);
  const { year, month } = ymRange(ym);
  const buf = await buildStockLedgerWorkbook({ year, month, rows: data.rows });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(stockLedgerFileName(year, month))}`,
    },
  });
}
