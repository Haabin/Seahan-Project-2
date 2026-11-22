import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth/session";
import { buildOrderTemplate } from "@/lib/excel/orders";

export const runtime = "nodejs";

/** 주문 입력용 엑셀 양식. 파일 이름은 (년월일)_주문목록.xlsx */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const db = await createSupabaseServer();
  const { data } = await db.from("products").select("code, name").order("name").limit(3);
  const buf = await buildOrderTemplate((data ?? []).map((p) => ({ itemCode: p.code, productName: p.name })));
  // 파일 이름: 내려받는 날(한국 시간) 기준 "20261122_주문목록.xlsx"
  const ymd = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${ymd}_주문목록.xlsx`)}`,
    },
  });
}
