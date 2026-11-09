import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth/session";
import { buildPlanWorkbook } from "@/lib/excel/export-plan";
import { loadCells, loadMasterData, loadPlanHeader } from "@/lib/data/load-engine-input";
import { dateRange } from "@/lib/engine/calendar";

export const runtime = "nodejs";

/** FR-12 현행 양식 엑셀 내보내기. ?revisionId=… (조회 권한도 가능; RLS가 확정본만 허용) */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });

  const url = new URL(req.url);
  const revisionId = url.searchParams.get("revisionId");
  if (!revisionId) return NextResponse.json({ error: "revisionId 가 필요합니다" }, { status: 400 });

  const db = await createSupabaseServer();
  const { data: rev, error } = await db.from("plan_revisions").select("id, plan_id, rev_no, status").eq("id", revisionId).maybeSingle();
  if (error || !rev) return NextResponse.json({ error: "Rev 를 찾을 수 없습니다" }, { status: 404 });

  const plan = await loadPlanHeader(db, rev.plan_id);
  if (!plan) return NextResponse.json({ error: "계획을 찾을 수 없습니다" }, { status: 404 });

  const [master, cells, downtimes] = await Promise.all([
    loadMasterData(db),
    loadCells(db, rev.id),
    db.from("downtimes").select("line_id, start_date, end_date, reason").lte("start_date", plan.periodEnd).gte("end_date", plan.periodStart),
  ]);

  const dates = dateRange(plan.periodStart, 15);
  const label = rev.status === "confirmed" ? `Rev ${rev.rev_no}` : "초안";
  const buf = await buildPlanWorkbook({
    periodStart: plan.periodStart,
    dates,
    lines: master.lines.filter((l) => l.isPlanTarget),
    products: master.products,
    allowedMolds: master.allowedMolds,
    cells,
    downtimes: (downtimes.data ?? []).map((d) => ({ lineId: d.line_id, startDate: d.start_date, endDate: d.end_date, reason: d.reason })),
    revisionLabel: label,
  });

  const fname = `주간생산계획_${plan.periodStart.replace(/-/g, "").slice(2)}_${label.replace(" ", "")}.xlsx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
  });
}
