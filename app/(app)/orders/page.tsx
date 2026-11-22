import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { loadOrders } from "@/lib/data/draft-data";
import { OrdersWorkspace } from "@/components/orders/orders-workspace";
import { PageHeader } from "@/components/ui";
import { todayKst } from "@/lib/orders/validate";

/** 주문 입력: 초안 자동 생성의 입력이 되는 이번 주 주문내역 */
export default async function OrdersPage() {
  const session = await requireSession();
  if (!canWrite(session.role)) redirect("/view");
  const db = await createSupabaseServer();
  const [orders, { data: products }, { data: customers }] = await Promise.all([
    loadOrders(db),
    db.from("products").select("id, code, name").order("name"),
    db.from("customers").select("name").order("name"),
  ]);
  return (
    <>
      <PageHeader title="주문 입력" sub="품명·수량·납기일·고객사. 여기 넣은 진행 중 주문이 생산계획표의 「초안 자동 생성」 입력이 됩니다." />
      <OrdersWorkspace orders={orders} products={products ?? []} customers={(customers ?? []).map((c) => c.name)} today={todayKst()} />
    </>
  );
}
