import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth/session";
import { buildOrderListWorkbook } from "@/lib/excel/orders";
import { loadOrders } from "@/lib/data/draft-data";

export const runtime = "nodejs";

/** 주문목록 엑셀: 지금 진행 중인 주문을 업로드 양식 그대로 내려받는다. 파일 이름은 (년월일)_주문목록.xlsx */
export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const db = await createSupabaseServer();
  // 지금 진행 중인 주문(직접 입력 + 엑셀 업로드 모두)을 양식 그대로 담는다. 없으면 예시 행이 든 빈 양식
  const [orders, { data: products }] = await Promise.all([loadOrders(db), db.from("products").select("id, code, name").order("name")]);
  const codeById = new Map((products ?? []).map((p) => [p.id as string, p.code as string]));
  const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
  const rows = orders
    .filter((o) => o.status === "open")
    .map((o) => ({
      orderNo: o.orderNo,
      itemCode: o.productId ? (codeById.get(o.productId) ?? null) : null,
      productName: o.productId ? (nameById.get(o.productId) ?? o.productNameRaw) : o.productNameRaw,
      qty: o.qty,
      dueDate: o.dueDate,
      customerName: o.customerName ?? null,
      memo: o.memo,
    }));
  const buf = await buildOrderListWorkbook(rows, (products ?? []).slice(0, 3).map((p) => ({ itemCode: p.code, productName: p.name })));
  // 파일 이름: 내려받는 날(한국 시간) 기준 "20261122_주문목록.xlsx"
  const ymd = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${ymd}_주문목록.xlsx`)}`,
    },
  });
}
