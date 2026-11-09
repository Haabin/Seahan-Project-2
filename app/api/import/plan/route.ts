import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { parsePlanWorkbook } from "@/lib/excel/import-plan";
import { ensurePlan, savePlanDraft } from "@/lib/actions/plan";

export const runtime = "nodejs";

/**
 * FR-03 현행 엑셀 계획표 가져오기.
 * multipart: file (.xlsx), periodStart (YYYY-MM-DD, 선택). 결과는 초안 셀 전체를 교체한다.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  const periodStartParam = (form.get("periodStart") as string | null) ?? undefined;
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });

  const db = await createSupabaseServer();
  const [{ data: lines }, { data: products }] = await Promise.all([
    db.from("lines").select("id, code, name").eq("is_plan_target", true),
    db.from("products").select("id, name"),
  ]);

  const buf = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = await parsePlanWorkbook(buf, { lines: lines ?? [], products: products ?? [], periodStart: periodStartParam });
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  const periodStart = periodStartParam ?? parsed.periodStart;
  if (!periodStart) return NextResponse.json({ error: "계획 시작일(목요일)을 찾지 못했습니다" }, { status: 400 });

  const ensured = await ensurePlan(periodStart);
  if (!ensured.ok) return NextResponse.json({ error: ensured.error }, { status: 400 });

  const saved = await savePlanDraft(ensured.data.planId, parsed.cells);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });

  await db.from("uploads").insert({
    kind: "plan",
    filename: file.name,
    uploaded_by: session.userId,
    row_count: parsed.cells.length,
    warnings: [...parsed.warnings, ...parsed.unmatched.map((u) => `${u.sheet}!${u.cellRef} ${u.lineCode} ${u.date}: "${u.text}" 매칭 실패`)],
  });

  return NextResponse.json({
    planId: ensured.data.planId,
    periodStart,
    cellCount: parsed.cells.length,
    unmatched: parsed.unmatched,
    warnings: parsed.warnings,
  });
}
