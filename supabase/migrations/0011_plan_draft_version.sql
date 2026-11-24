-- =====================================================================
-- 0011_plan_draft_version.sql · 초안 저장 충돌 감지
-- - plan_revisions 에 version / updated_at / updated_by / save_token 열을 더한다.
-- - plan_cells 가 바뀌면(넣기·고치기·지우기, 경로 무관) 그 **초안** Rev 의 version 을 +1 한다 (문장 단위 트리거).
--   확정 Rev 는 고치지 않는다 → 확정 Rev 불변 트리거(plan_revisions_immutable)와 충돌하지 않는다.
-- - save_plan_draft(): 버전 확인 + 셀 지우기 + 셀 넣기를 한 트랜잭션으로 (지우기와 넣기 사이 실패로 셀이 사라지는 위험 제거).
--   호출자 권한(security invoker)이라 plan_cells·plan_revisions 의 RLS 와 불변 트리거가 그대로 적용된다.
-- 여러 번 실행해도 결과가 같다. 예전 savePlanDraft(지우기 → 넣기)도 그대로 동작한다(트리거가 version 만 올린다).
--
-- 되돌리기:
--   drop trigger if exists plan_cells_bump_ins on plan_cells;
--   drop trigger if exists plan_cells_bump_upd on plan_cells;
--   drop trigger if exists plan_cells_bump_del on plan_cells;
--   drop function if exists bump_draft_version_ins();
--   drop function if exists bump_draft_version_upd();
--   drop function if exists bump_draft_version_del();
--   drop function if exists bump_draft_versions(uuid[]);
--   drop function if exists save_plan_draft(uuid, int, uuid, jsonb);
--   drop function if exists app_display_name(uuid);
--   alter table plan_revisions drop column if exists save_token, drop column if exists updated_by,
--     drop column if exists updated_at, drop column if exists version;
-- =====================================================================

-- 1) 열. 상수 기본값을 가진 열 추가는 기존 행을 다시 쓰지 않는다(UPDATE 트리거가 돌지 않음) → 확정 Rev 도 안전
alter table plan_revisions add column if not exists version int not null default 0;
alter table plan_revisions add column if not exists updated_at timestamptz;   -- 마지막으로 셀이 바뀐 시각 (0011 이전은 null)
alter table plan_revisions add column if not exists updated_by uuid;          -- FK 없음: 사용자를 지울 때 확정 Rev 를 고치지 않게
alter table plan_revisions add column if not exists save_token uuid;          -- 마지막 save_plan_draft 표식 (응답을 못 받은 저장 복구용)

-- 2) 초안 version 올리기. 확정 Rev 는 where 에서 빠진다
create or replace function bump_draft_versions(ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update plan_revisions
     set version = version + 1, updated_at = now(), updated_by = auth.uid(), save_token = null
   where id = any(ids) and status = 'draft';
$$;
revoke all on function bump_draft_versions(uuid[]) from public, anon, authenticated;

create or replace function bump_draft_version_ins() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform bump_draft_versions(array(select distinct n.revision_id from new_rows n));
  return null;
end $$;

create or replace function bump_draft_version_del() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform bump_draft_versions(array(select distinct o.revision_id from old_rows o));
  return null;
end $$;

create or replace function bump_draft_version_upd() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform bump_draft_versions(array(select n.revision_id from new_rows n union select o.revision_id from old_rows o));
  return null;
end $$;

-- 문장 단위: 저장 1번(지우기 1문장 + 넣기 1문장)에 +2. 0행 문장은 transition table 이 비어 version 이 그대로다
drop trigger if exists plan_cells_bump_ins on plan_cells;
create trigger plan_cells_bump_ins after insert on plan_cells
  referencing new table as new_rows
  for each statement execute function bump_draft_version_ins();

drop trigger if exists plan_cells_bump_upd on plan_cells;
create trigger plan_cells_bump_upd after update on plan_cells
  referencing old table as old_rows new table as new_rows
  for each statement execute function bump_draft_version_upd();

drop trigger if exists plan_cells_bump_del on plan_cells;
create trigger plan_cells_bump_del after delete on plan_cells
  referencing old table as old_rows
  for each statement execute function bump_draft_version_del();

-- 3) 충돌 알림용 표시 이름. 작성 권한자에게 이름만 준다 (profiles RLS 는 본인만 읽게 되어 있다)
create or replace function app_display_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.display_name from profiles p where p.user_id = p_user and app_can_write();
$$;
revoke all on function app_display_name(uuid) from public, anon;
grant execute on function app_display_name(uuid) to authenticated, service_role;

-- 4) 원자적 초안 저장
--    p_expected_version: 화면이 마지막으로 본 version. null 이면 확인 없이 저장(「내 것으로 덮어쓰기」, 엑셀 가져오기)
--    p_token: 이번 저장 표식. version 이 달라도 save_token 이 같으면 "응답만 못 받은 내 직전 저장"으로 보고 이어서 저장한다
--    반환 열은 plan_revisions 열 이름과 겹치지 않게 out_ 을 붙인다 (plpgsql 변수·열 이름 모호성 방지)
create or replace function save_plan_draft(p_revision_id uuid, p_expected_version int, p_token uuid, p_cells jsonb)
returns table(
  out_status text,
  out_version int,
  out_updated_at timestamptz,
  out_updated_by uuid,
  out_updated_by_name text,
  out_rev_no int
)
language plpgsql security invoker set search_path = public as $$
declare
  r plan_revisions%rowtype;
begin
  -- 같은 초안에 대한 저장을 한 줄로 세운다
  select pr.* into r from plan_revisions pr where pr.id = p_revision_id for update;
  if not found then
    return query select 'missing'::text, null::int, null::timestamptz, null::uuid, null::text, null::int;
    return;
  end if;
  if r.status <> 'draft' then
    return query select 'confirmed'::text, r.version, r.confirmed_at, r.updated_by, app_display_name(r.updated_by), r.rev_no;
    return;
  end if;
  if p_expected_version is not null and r.version <> p_expected_version
     and (p_token is null or r.save_token is distinct from p_token) then
    return query select 'conflict'::text, r.version, r.updated_at, r.updated_by, app_display_name(r.updated_by), null::int;
    return;
  end if;

  delete from plan_cells pc where pc.revision_id = p_revision_id;
  insert into plan_cells (revision_id, line_id, date, product_id, qty, changeover_type, memo,
                          lost_hours_override, mold_id, origin, basis, order_id)
  select p_revision_id, x.line_id, x.date, x.product_id, x.qty, x.changeover_type, x.memo,
         x.lost_hours_override, x.mold_id, coalesce(x.origin, 'manual'), x.basis, x.order_id
    from jsonb_to_recordset(coalesce(p_cells, '[]'::jsonb)) as x(
      line_id uuid, date date, product_id uuid, qty numeric, changeover_type changeover_type, memo text,
      lost_hours_override int, mold_id uuid, origin text, basis text, order_id uuid);

  -- 트리거가 올린 version 을 읽고, 표식은 마지막에 남긴다 (트리거는 표식을 지운다)
  update plan_revisions pr set save_token = p_token where pr.id = p_revision_id
    returning pr.* into r;
  return query select 'ok'::text, r.version, r.updated_at, r.updated_by, app_display_name(r.updated_by), null::int;
end $$;
revoke all on function save_plan_draft(uuid, int, uuid, jsonb) from public, anon;
grant execute on function save_plan_draft(uuid, int, uuid, jsonb) to authenticated, service_role;
