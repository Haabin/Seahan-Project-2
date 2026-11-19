import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth/session";
import { buildOrderTemplate } from "@/lib/excel/orders";

export const runtime = "nodejs";

/** 주문내역 엑셀 템플릿 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const db = await createSupabaseServer();
  const { data } = await db.from("products").select("code, name").order("name").limit(3);
  const buf = await buildOrderTemplate((data ?? []).map((p) => ({ itemCode: p.code, productName: p.name })));
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("주문내역_템플릿.xlsx")}`,
    },
  });
}
