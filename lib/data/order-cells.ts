import type { createSupabaseServer } from "@/lib/supabase/server";

type DB = Awaited<ReturnType<typeof createSupabaseServer>>;

/**
 * 그 주문으로 초안 자동 생성이 만든 셀을 초안에서 지운다.
 * 확정된 Rev 는 건드리지 않는다(NFR-09). 사람이 고친 셀(origin = manual)도 남긴다.
 */
export async function removeDraftCellsOfOrder(db: DB, orderId: string): Promise<number> {
  const { data: drafts } = await db.from("plan_revisions").select("id").eq("status", "draft");
  const ids = (drafts ?? []).map((d) => d.id);
  if (!ids.length) return 0;
  const { data, error } = await db.from("plan_cells").delete().in("revision_id", ids).eq("order_id", orderId).eq("origin", "auto").select("line_id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
