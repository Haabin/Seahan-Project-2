"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/session";
import { lineSpecInputSchema, lineSpecToRow } from "@/lib/data/line-specs";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

/** 설비 상세 정보 저장 (기준정보 화면, admin) */
export async function upsertLineSpec(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireAdmin();
    const parsed = lineSpecInputSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(", "));
    const db = await createSupabaseServer();
    const { error } = await db
      .from("line_specs")
      .upsert({ ...lineSpecToRow(parsed.data), updated_by: s.userId, updated_at: new Date().toISOString() }, { onConflict: "line_id" });
    if (error) return fail(error.message);
    revalidatePath("/master");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
