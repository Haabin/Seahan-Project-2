import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { isAdmin, requireSession } from "@/lib/auth/session";
import { loadMasterData } from "@/lib/data/load-engine-input";
import { MasterPanels } from "@/components/master/master-panels";
import { PageHeader } from "@/components/ui";
import { lineSpecFromRow } from "@/lib/data/line-specs";

export default async function MasterPage() {
  const session = await requireSession();
  if (!isAdmin(session.role)) redirect("/plan");
  const db = await createSupabaseServer();
  const [master, settings, customers, users, upload, specs] = await Promise.all([
    loadMasterData(db),
    db.from("settings").select("key, value, description, updated_at").order("key"),
    db.from("customers").select("id, name, is_major").order("name"),
    db.from("profiles").select("user_id, display_name, role, team").order("display_name"),
    db.from("uploads").select("uploaded_at").eq("kind", "master").order("uploaded_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("line_specs").select("*"),
  ]);
  // 0003_line_specs.sql 적용 전이면 테이블이 없어 오류 → 빈 목록으로 표시 (기준정보 화면은 그대로 동작)
  if (specs.error) console.warn(`line_specs 조회 실패: ${specs.error.message}`);

  return (
    <>
      <PageHeader title="기준정보" sub="호기 · 허용 금형 · Capa · 교체 손실 계수 · 설정값 · 계정. 모든 수정은 수정자·시각이 감사 로그에 남습니다 (FR-01, NFR-07)" />
      <MasterPanels
        lines={master.lines}
        products={master.products}
        allowed={master.allowedMolds}
        capacities={master.capacities}
        coefficients={master.changeoverCoefficients}
        lineSpecs={specs.error ? [] : (specs.data ?? []).map(lineSpecFromRow)}
        settings={(settings.data ?? []).map((s) => ({ key: s.key, value: s.value, description: s.description, updatedAt: s.updated_at }))}
        customers={(customers.data ?? []).map((c) => ({ id: c.id, name: c.name, isMajor: c.is_major }))}
        users={(users.data ?? []).map((u) => ({ userId: u.user_id, displayName: u.display_name, role: u.role, team: u.team }))}
        lastMasterUpload={upload.data?.uploaded_at ?? null}
      />
    </>
  );
}
