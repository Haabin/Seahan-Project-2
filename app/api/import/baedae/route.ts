import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { isBaedaeWorkbook, parseBaedaeWorkbook, type BaedaeCell } from "@/lib/excel/import-baedae";
import { normalizeName } from "@/lib/excel/common";
import { addDays } from "@/lib/engine/calendar";

export const runtime = "nodejs";

/**
 * 현장 「생산배대」 엑셀 가져오기 (과거 계획 → 확정 Rev).
 * multipart: file(.xlsx), mode('preview' | 'apply'), revNo(선택), mapping(JSON: 제품명 → 제품 id | "new" | "skip")
 *  - preview: 형식 판별 + 해석 결과(셀, 교체, 화살표, 경고, 매칭 안 된 제품명). 아무것도 쓰지 않는다.
 *  - apply  : 계획 대상 호기(1-Stage) 시트를 plans / plan_revisions(confirmed) / plan_cells 로 저장한다.
 *             같은 기간에 같은 Rev 번호가 있으면 다음 번호로 쌓는다. 사출 설비의 원료 소비량(톤)도 저장한다.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });
  const mode = form.get("mode") === "apply" ? "apply" : "preview";
  const buf = Buffer.from(await file.arrayBuffer());

  if (!(await isBaedaeWorkbook(buf))) return NextResponse.json({ format: "other" });

  const db = await createSupabaseServer();
  const [{ data: settings }, { data: lineRows }, { data: productRows }, { data: moldLinks }] = await Promise.all([
    db.from("settings").select("key, value").in("key", ["baedae_arrow_min_cover", "baedae_arrow_ambiguous"]),
    db.from("lines").select("id, code, name, is_plan_target, sort_order"),
    db.from("products").select("id, code, name"),
    db.from("mold_products").select("mold_id, product_id"),
  ]);
  const setting = (k: string) => settings?.find((s) => s.key === k)?.value;
  const amb = setting("baedae_arrow_ambiguous");

  let parsed;
  try {
    parsed = await parseBaedaeWorkbook(buf, {
      filename: file.name,
      arrowMinCover: Number(setting("baedae_arrow_min_cover") ?? 0.5) || 0.5,
      arrowAmbiguous: Array.isArray(amb) && amb.length === 2 ? [Number(amb[0]), Number(amb[1])] : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }

  const lineByCode = new Map((lineRows ?? []).map((l) => [l.code as string, l] as const));
  const productByName = new Map((productRows ?? []).map((p) => [normalizeName(p.name), p] as const));
  const productById = new Map((productRows ?? []).map((p) => [p.id as string, p] as const));

  // 계획 대상 호기(1-Stage)의 셀만 계획으로 저장한다
  const planCells: BaedaeCell[] = [];
  const allowedText = new Map<string, string[]>();
  const candidatesByLine = new Map<string, string[]>();
  for (const s of parsed.sheets) {
    for (const m of s.machines) {
      if (lineByCode.get(m.code)?.is_plan_target) {
        allowedText.set(m.code, m.allowedMoldText);
        candidatesByLine.set(m.code, m.allowedMoldNames);
      }
    }
    for (const c of s.cells) if (lineByCode.get(c.lineCode)?.is_plan_target) planCells.push(c);
  }
  const dates = parsed.sheets[0]?.dates ?? [];
  const periodStart = parsed.periodStart;

  // 제품명 매칭
  const nameInfo = new Map<string, { name: string; days: number; lines: Set<string>; productId: string | null }>();
  for (const c of planCells) {
    const key = normalizeName(c.productName);
    const e = nameInfo.get(key) ?? { name: c.productName, days: 0, lines: new Set<string>(), productId: productByName.get(key)?.id ?? null };
    e.days++;
    e.lines.add(c.lineCode);
    nameInfo.set(key, e);
  }
  const names = Array.from(nameInfo.values())
    .map((n) => ({
      name: n.name,
      days: n.days,
      lines: Array.from(n.lines),
      productId: n.productId,
      // B열 생산 가능 금형 목록을 후보로 보여준다
      candidates: Array.from(new Set(Array.from(n.lines).flatMap((l) => candidatesByLine.get(l) ?? []))).slice(0, 12),
    }))
    .sort((a, b) => Number(!!a.productId) - Number(!!b.productId) || a.name.localeCompare(b.name, "ko"));

  let existingRevs: number[] = [];
  let planId: string | null = null;
  if (periodStart) {
    const { data: plan } = await db.from("plans").select("id, plan_revisions(rev_no, status)").eq("process_tab", "1STAGE").eq("period_start", periodStart).maybeSingle();
    planId = plan?.id ?? null;
    existingRevs = ((plan?.plan_revisions ?? []) as { rev_no: number | null; status: string }[]).filter((r) => r.status === "confirmed" && r.rev_no !== null).map((r) => r.rev_no as number);
  }
  const resin = parsed.sheets.flatMap((s) => s.resinUsage).filter((u) => lineByCode.has(u.lineCode));

  const preview = {
    format: "baedae" as const,
    mode,
    filename: file.name,
    revNo: parsed.revNo,
    periodStart,
    periodEnd: parsed.periodEnd,
    dates,
    isThursday: periodStart ? new Date(`${periodStart}T00:00:00Z`).getUTCDay() === 4 : false,
    lines: (lineRows ?? [])
      .filter((l) => l.is_plan_target && allowedText.has(l.code))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({ code: l.code as string, name: l.name as string, allowedText: allowedText.get(l.code) ?? [] })),
    cells: planCells.map((c) => ({ lineCode: c.lineCode, date: c.date, productName: c.productName, changeoverType: c.changeoverType, qty: c.qty, memo: c.memo, source: c.source, cover: c.cover })),
    names,
    existingRevs,
    resinCount: resin.length,
    rectThresholdEmu: parsed.rectThresholdEmu,
    sheets: parsed.sheets.map((s) => ({
      sheetName: s.sheetName,
      stats: s.stats,
      machineCount: s.machines.length,
      stored: s.machines.some((m) => lineByCode.get(m.code)?.is_plan_target),
      warnings: s.warnings.filter((w) => w.level === "warn").map((w) => `${w.lineCode ?? ""} ${w.date?.slice(5) ?? ""} ${w.message}`.trim()),
      infoCount: s.warnings.filter((w) => w.level === "info").length,
    })),
    warnings: parsed.warnings.map((w) => w.message),
    skippedSheets: parsed.skippedSheets,
  };
  if (mode === "preview") return NextResponse.json(preview);

  // ---------------- apply ----------------
  if (!periodStart || dates.length < 15) return NextResponse.json({ error: "계획 기간(15일)을 읽지 못했습니다" }, { status: 400 });
  if (!planCells.length) return NextResponse.json({ error: "저장할 1-Stage 계획 셀이 없습니다" }, { status: 400 });
  const revInput = form.get("revNo");
  const wantedRev = revInput !== null && String(revInput).trim() !== "" ? Number(revInput) : parsed.revNo;
  if (wantedRev === null || !Number.isInteger(wantedRev) || wantedRev < 0) return NextResponse.json({ error: "Rev 번호를 입력하세요(0 이상의 정수)" }, { status: 400 });

  let mapping: Record<string, string> = {};
  try {
    mapping = JSON.parse(String(form.get("mapping") ?? "{}"));
  } catch {
    return NextResponse.json({ error: "매칭 정보가 올바르지 않습니다" }, { status: 400 });
  }

  // 제품명 → 제품 id. 매칭 안 된 이름은 화면에서 고른 대로: 기존 제품 / 새 제품 등록 / 건너뛰기
  const resolved = new Map<string, string | null>();
  const created: string[] = [];
  for (const n of names) {
    const key = normalizeName(n.name);
    if (n.productId) {
      resolved.set(key, n.productId);
      continue;
    }
    const choice = mapping[n.name] ?? "skip";
    if (choice === "skip") resolved.set(key, null);
    else if (choice === "new") {
      const code = `BD-${createHash("sha1").update(key).digest("hex").slice(0, 8).toUpperCase()}`;
      const ins = await db.from("products").insert({ code, name: n.name, updated_by: session.userId }).select("id").single();
      if (ins.error) return NextResponse.json({ error: `제품 "${n.name}" 등록 실패: ${ins.error.message}` }, { status: 400 });
      resolved.set(key, ins.data.id);
      created.push(n.name);
      const mold = await db.from("molds").insert({ mold_no: code, name: n.name, updated_by: session.userId }).select("id").single();
      if (!mold.error) {
        await db.from("mold_products").insert({ mold_id: mold.data.id, product_id: ins.data.id });
        (moldLinks ?? []).push({ mold_id: mold.data.id, product_id: ins.data.id });
      }
    } else if (productById.has(choice)) resolved.set(key, choice);
    else resolved.set(key, null);
  }

  // 가져온 제품을 그 호기의 허용 금형에 넣는다(없는 것만). 기존 허용 금형 제약이 깨지지 않게
  const { data: allowedRows } = await db.from("line_allowed_molds").select("line_id, product_id");
  const allowedSet = new Set((allowedRows ?? []).map((a) => `${a.line_id}|${a.product_id}`));
  const newAllowed: { line_id: string; product_id: string }[] = [];

  const moldsOf = new Map<string, string[]>();
  for (const l of moldLinks ?? []) moldsOf.set(l.product_id, [...(moldsOf.get(l.product_id) ?? []), l.mold_id]);

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  const periodEnd = addDays(periodStart, 14);
  for (const c of planCells) {
    if (c.date < periodStart || c.date > periodEnd) continue;
    const productId = resolved.get(normalizeName(c.productName)) ?? null;
    const line = lineByCode.get(c.lineCode)!;
    if (!productId) {
      skipped++;
      continue;
    }
    const k = `${line.id}|${productId}`;
    if (!allowedSet.has(k)) {
      allowedSet.add(k);
      newAllowed.push({ line_id: line.id, product_id: productId });
    }
    const molds = moldsOf.get(productId) ?? [];
    const color = c.changeoverColor ? ` · 네모 색 ${c.changeoverColor}` : "";
    rows.push({
      line_id: line.id,
      date: c.date,
      product_id: productId,
      qty: c.qty,
      changeover_type: c.changeoverType,
      memo: c.memo,
      mold_id: molds.length === 1 ? molds[0] : null,
      origin: "imported",
      basis: `가져오기: ${file.name}${c.source === "arrow" ? " · 화살표 구간" : ""}${color}`.slice(0, 300),
    });
  }
  if (!rows.length) return NextResponse.json({ error: "매칭된 제품이 없어 저장할 셀이 없습니다. 제품을 연결하거나 새로 등록하세요" }, { status: 400 });
  if (newAllowed.length) {
    const ins = await db.from("line_allowed_molds").insert(newAllowed);
    if (ins.error) return NextResponse.json({ error: `허용 금형 등록 실패: ${ins.error.message}` }, { status: 400 });
  }

  if (!planId) {
    const { data: factory } = await db.from("factories").select("id").eq("code", "F1").single();
    if (!factory) return NextResponse.json({ error: "1공장 기준정보가 없습니다" }, { status: 400 });
    const ins = await db.from("plans").insert({ factory_id: factory.id, process_tab: "1STAGE", period_start: periodStart, period_end: periodEnd, created_by: session.userId }).select("id").single();
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
    planId = ins.data.id as string;
  }
  // 같은 Rev 번호가 있으면 다음 번호로 쌓는다
  const revNo = existingRevs.includes(wantedRev) ? Math.max(...existingRevs) + 1 : wantedRev;
  const source = `생산배대: ${file.name}${revNo !== wantedRev ? ` (파일 표기 Rev ${wantedRev})` : ""}`;

  const upload = await db
    .from("uploads")
    .insert({ kind: "baedae", filename: file.name, uploaded_by: session.userId, row_count: rows.length, warnings: preview.sheets.flatMap((s) => s.warnings).slice(0, 200) })
    .select("id")
    .single();
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  // 확정 Rev 에는 셀을 넣을 수 없으므로(NFR-09 트리거) 초안으로 만들어 셀을 넣고 바로 확정한다
  const rev = await db.from("plan_revisions").insert({ plan_id: planId, status: "draft", created_by: session.userId, source }).select("id").single();
  if (rev.error) return NextResponse.json({ error: rev.error.message }, { status: 400 });
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await db.from("plan_cells").insert(rows.slice(i, i + 500).map((r) => ({ ...r, revision_id: rev.data.id })));
    if (ins.error) {
      await db.from("plan_revisions").delete().eq("id", rev.data.id);
      return NextResponse.json({ error: `계획 셀 저장 실패: ${ins.error.message}` }, { status: 400 });
    }
  }
  const confirm = await db
    .from("plan_revisions")
    .update({
      status: "confirmed",
      rev_no: revNo,
      reason_category: revNo > 0 ? "기타" : null,
      reason_text: revNo > 0 ? `엑셀 가져오기: ${file.name}` : null,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", rev.data.id);
  if (confirm.error) {
    await db.from("plan_revisions").delete().eq("id", rev.data.id);
    return NextResponse.json({ error: `확정 저장 실패: ${confirm.error.message}` }, { status: 400 });
  }

  if (resin.length) {
    const resinRows = resin.map((u) => ({ line_id: lineByCode.get(u.lineCode)!.id, date: u.date, ton: u.ton, upload_id: upload.data.id }));
    await db.from("line_resin_usage").upsert(resinRows, { onConflict: "line_id,date" });
  }

  return NextResponse.json({ ...preview, mode, planId, revisionId: rev.data.id, savedRevNo: revNo, savedCells: rows.length, skippedCells: skipped, createdProducts: created, resinSaved: resin.length });
}
