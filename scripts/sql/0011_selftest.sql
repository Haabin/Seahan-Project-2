-- =====================================================================
-- ⚠️ 마이그레이션 아님. 실행해도 남는 것 없음 (마지막 줄이 rollback;).
-- scripts/sql/0011_selftest.sql · 0011_plan_draft_version.sql 적용 후 되돌리는 시험
--
-- 실행 방법: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여 넣고 Run.
--   결과의 Messages(알림)에 「PASS T1 … PASS T15」와 「모든 시험 통과」가 보이면 통과.
--   실패하면 「T? 실패: …」 오류로 멈추고, 트랜잭션은 취소된다.
--   이 파일은 supabase/migrations/ 밖에 있어 npm run db:migrate 가 실행하지 않는다.
--
-- 순서: begin → 0011 본문(아래 「0011 시작」~「0011 끝」, 마이그레이션 파일과 같은 내용 —
--       tests/unit/data/migration-0011-selftest.test.ts 가 같은지 확인한다) → 시험 → rollback
-- 0011 이 이미 적용된 DB 에서도 돌릴 수 있다 (0011 은 여러 번 실행해도 결과가 같다).
--
-- 한계:
--   - SQL Editor 는 postgres 권한이라 RLS 를 거치지 않고 auth.uid() 가 null 이다.
--     → RLS(작성 권한자만 저장)와 updated_by·app_display_name 은 여기서 시험되지 않는다.
--     → 실행 권한(anon 불가, authenticated 가능)도 여기서는 확인되지 않는다. 적용 뒤 확인용 SQL 은 PR 본문 참고.
--   - 0011 의 alter table 과 시험 중 alter table ... disable trigger 가 plans·plan_revisions·plan_cells 에
--     잠깐 배타 잠금을 건다. 운영 DB 이므로 아무도 계획을 고치지 않을 때 실행한다(보통 1초 이내).
-- =====================================================================

begin;

-- >>> 0011 시작 -------------------------------------------------------
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
-- <<< 0011 끝 ---------------------------------------------------------

-- =====================================================================
-- 시험. 기대와 다르면 raise exception 으로 멈춘다 (그래도 아래 rollback 으로 아무것도 남지 않는다).
-- 시험용 계획은 process_tab = 'SELFTEST_0011', 기간 2099-01 이라 기존 계획과 겹치지 않는다.
-- =====================================================================
-- 결과 기록: 알림(raise notice)과 함께 임시 표에도 쌓아, 맨 끝에서 결과 표로 보여준다 (rollback 으로 사라짐)
create temp table selftest_0011_results (no serial, item text);
create function pg_temp.selftest_pass(msg text) returns void language plpgsql as $f$
begin
  insert into selftest_0011_results (item) values (msg);
  raise notice '%', msg;
end $f$;

do $$
declare
  v_factory uuid; v_line uuid; v_p1 uuid; v_p2 uuid; v_mold uuid;
  v_plan uuid; v_plan2 uuid; v_draft uuid; v_draft2 uuid; v_conf uuid;
  v_ver int; v_ver_before int; v_at timestamptz; v_conf_ver int; v_conf_at timestamptz; v_conf_cells int;
  v_order uuid := gen_random_uuid();
  v_tok uuid := gen_random_uuid();
  v_tok2 uuid := gen_random_uuid();
  v_cells jsonb;
  res record; c record; n int; raised boolean;
begin
  -- 기존 기준정보에서 id 만 빌린다 (기존 행은 고치지 않는다)
  select id into v_factory from factories where code = 'F1';
  if v_factory is null then select id into v_factory from factories limit 1; end if;
  select id into v_line from lines order by sort_order, code limit 1;
  select id into v_p1 from products order by code limit 1;
  select id into v_p2 from products order by code offset 1 limit 1;
  if v_p2 is null then v_p2 := v_p1; end if;
  select id into v_mold from molds order by mold_no limit 1;   -- 없으면 null 로 시험
  if v_factory is null or v_line is null or v_p1 is null then
    raise exception '시험에 필요한 공장·호기·제품 기준정보가 없습니다';
  end if;

  insert into plans (factory_id, process_tab, period_start, period_end)
    values (v_factory, 'SELFTEST_0011', '2099-01-01', '2099-01-15') returning id into v_plan;
  insert into plan_revisions (plan_id, status) values (v_plan, 'draft') returning id into v_draft;

  -- T1 새 Rev 기본값
  select version, updated_at into v_ver, v_at from plan_revisions where id = v_draft;
  if v_ver <> 0 or v_at is not null then raise exception 'T1 실패: 새 Rev version=% updated_at=%', v_ver, v_at; end if;
  perform pg_temp.selftest_pass(format('PASS T1 새 Rev 는 version 0, updated_at null'));

  -- T2 셀 넣기 → version +1, updated_at 채워짐
  insert into plan_cells (revision_id, line_id, date, product_id)
    values (v_draft, v_line, '2099-01-01', v_p1), (v_draft, v_line, '2099-01-02', v_p1);
  select version, updated_at into v_ver, v_at from plan_revisions where id = v_draft;
  if v_ver <> 1 or v_at is null then raise exception 'T2 실패: version=% updated_at=%', v_ver, v_at; end if;
  perform pg_temp.selftest_pass(format('PASS T2 초안 셀 넣기(2행 1문장) → version 1, updated_at 채워짐'));

  -- T3 셀 고치기 → +1
  update plan_cells set qty = 100 where revision_id = v_draft;
  select version into v_ver from plan_revisions where id = v_draft;
  if v_ver <> 2 then raise exception 'T3 실패: version=%', v_ver; end if;
  perform pg_temp.selftest_pass(format('PASS T3 초안 셀 고치기 → version 2'));

  -- T4 셀 지우기 → +1
  delete from plan_cells where revision_id = v_draft and date = '2099-01-02';
  select version into v_ver from plan_revisions where id = v_draft;
  if v_ver <> 3 then raise exception 'T4 실패: version=%', v_ver; end if;
  perform pg_temp.selftest_pass(format('PASS T4 초안 셀 지우기 → version 3'));

  -- T5 0행 문장 → 그대로
  delete from plan_cells where revision_id = v_draft and date = '2099-12-31';
  insert into plan_cells select * from plan_cells where false;
  update plan_cells set qty = 1 where false;
  select version into v_ver from plan_revisions where id = v_draft;
  if v_ver <> 3 then raise exception 'T5 실패: 0행 문장 뒤 version=%', v_ver; end if;
  perform pg_temp.selftest_pass(format('PASS T5 0행 지우기·넣기·고치기 → version 그대로 3'));

  -- T6 save_plan_draft: 맞는 버전 → ok, 셀 값이 넣은 그대로
  v_cells := jsonb_build_array(
    jsonb_build_object('line_id', v_line, 'date', '2099-01-03', 'product_id', v_p2, 'qty', 12345, 'changeover_type', 'BM',
                       'memo', '메모 시험', 'lost_hours_override', 5, 'mold_id', v_mold, 'origin', 'auto', 'basis', '근거 시험', 'order_id', v_order),
    jsonb_build_object('line_id', v_line, 'date', '2099-01-04', 'product_id', null, 'qty', null, 'changeover_type', 'NONE', 'memo', '메모만'));
  select * into res from save_plan_draft(v_draft, 3, v_tok, v_cells);
  if res.out_status <> 'ok' then raise exception 'T6 실패: status=%', res.out_status; end if;
  if res.out_version <> 5 then raise exception 'T6 실패: 지우기+넣기 뒤 version=% (기대 5)', res.out_version; end if;
  if (select save_token from plan_revisions where id = v_draft) is distinct from v_tok then raise exception 'T6 실패: save_token 이 남지 않음'; end if;
  select count(*) into n from plan_cells where revision_id = v_draft;
  if n <> 2 then raise exception 'T6 실패: 셀 %개 (기대 2)', n; end if;
  select * into c from plan_cells where revision_id = v_draft and date = '2099-01-03';
  if c.line_id <> v_line or c.product_id <> v_p2 or c.qty <> 12345 or c.changeover_type <> 'BM' or c.memo <> '메모 시험'
     or c.lost_hours_override <> 5 or c.mold_id is distinct from v_mold or c.origin <> 'auto' or c.basis <> '근거 시험' or c.order_id <> v_order then
    raise exception 'T6 실패: 저장된 셀 값이 다름: %', row_to_json(c);
  end if;
  select * into c from plan_cells where revision_id = v_draft and date = '2099-01-04';
  if c.product_id is not null or c.qty is not null or c.changeover_type <> 'NONE' or c.memo <> '메모만' or c.origin <> 'manual'
     or c.lost_hours_override is not null or c.mold_id is not null or c.basis is not null or c.order_id is not null then
    raise exception 'T6 실패: 빈 값·기본값 셀이 다름: %', row_to_json(c);
  end if;
  perform pg_temp.selftest_pass(format('PASS T6 save_plan_draft 맞는 버전 → ok, version 5, 셀 값(제품·수량·교체·메모·비가동·금형·origin·근거·주문) 그대로 (mold 시험값: %s)', coalesce(v_mold::text, 'null')));

  -- T7 틀린 버전 + 다른 표식 → conflict, 셀·version 그대로
  select * into res from save_plan_draft(v_draft, 4, v_tok2, '[]'::jsonb);
  if res.out_status <> 'conflict' or res.out_version <> 5 then raise exception 'T7 실패: status=% version=%', res.out_status, res.out_version; end if;
  select count(*) into n from plan_cells where revision_id = v_draft;
  select version into v_ver from plan_revisions where id = v_draft;
  if n <> 2 or v_ver <> 5 then raise exception 'T7 실패: 충돌 뒤 셀 %개 version %', n, v_ver; end if;
  perform pg_temp.selftest_pass(format('PASS T7 틀린 버전 → conflict, 셀 2개·version 5 그대로'));

  -- T8 틀린 버전 + 같은 표식(응답을 못 받은 내 직전 저장) → ok
  select * into res from save_plan_draft(v_draft, 3, v_tok, v_cells);
  if res.out_status <> 'ok' then raise exception 'T8 실패: status=%', res.out_status; end if;
  v_ver := res.out_version;
  perform pg_temp.selftest_pass(format('PASS T8 틀린 버전 + 같은 save_token → ok (version %s)', v_ver));

  -- T9 다른 저장이 끼어든 뒤 같은 표식 → conflict
  insert into plan_cells (revision_id, line_id, date, product_id) values (v_draft, v_line, '2099-01-05', v_p1);  -- 예전 코드·주문 삭제 같은 다른 경로
  if (select save_token from plan_revisions where id = v_draft) is not null then raise exception 'T9 실패: 다른 경로 변경 뒤 save_token 이 지워지지 않음'; end if;
  select * into res from save_plan_draft(v_draft, v_ver, v_tok, '[]'::jsonb);
  if res.out_status <> 'conflict' then raise exception 'T9 실패: status=%', res.out_status; end if;
  perform pg_temp.selftest_pass(format('PASS T9 다른 변경이 끼어든 뒤 같은 save_token → conflict'));

  -- T10 p_expected_version null → ok (덮어쓰기)
  select * into res from save_plan_draft(v_draft, null, gen_random_uuid(), v_cells);
  if res.out_status <> 'ok' then raise exception 'T10 실패: status=%', res.out_status; end if;
  select count(*) into n from plan_cells where revision_id = v_draft;
  if n <> 2 then raise exception 'T10 실패: 셀 %개', n; end if;
  perform pg_temp.selftest_pass(format('PASS T10 expected null → ok, 내 내용으로 교체'));

  -- T11 없는 id → missing
  select * into res from save_plan_draft(gen_random_uuid(), 0, null, '[]'::jsonb);
  if res.out_status <> 'missing' then raise exception 'T11 실패: status=%', res.out_status; end if;
  perform pg_temp.selftest_pass(format('PASS T11 없는 Rev → missing'));

  -- T12 생산배대 순서: 초안으로 만들어 셀 넣고 바로 확정
  insert into plan_revisions (plan_id, status) values (v_plan, 'draft') returning id into v_conf;
  insert into plan_cells (revision_id, line_id, date, product_id) values (v_conf, v_line, '2099-01-01', v_p1), (v_conf, v_line, '2099-01-02', v_p2);
  update plan_revisions set status = 'confirmed', rev_no = 0, confirmed_at = now() where id = v_conf;
  select version, updated_at into v_conf_ver, v_conf_at from plan_revisions where id = v_conf;
  select count(*) into v_conf_cells from plan_cells where revision_id = v_conf;
  if v_conf_ver <> 1 or v_conf_cells <> 2 then raise exception 'T12 실패: 확정 Rev version=% 셀=%', v_conf_ver, v_conf_cells; end if;
  perform pg_temp.selftest_pass(format('PASS T12 초안 → 셀 넣기 → 확정 순서 오류 없음 (확정 Rev version %s)', v_conf_ver));

  -- T13 확정 Rev: 셀 넣기는 불변 트리거가 막고 version·updated_at 그대로
  raised := false;
  begin
    insert into plan_cells (revision_id, line_id, date, product_id) values (v_conf, v_line, '2099-01-03', v_p1);
  exception when others then raised := true;
  end;
  if not raised then raise exception 'T13 실패: 확정 Rev 에 셀이 들어감'; end if;

  -- 스크립트처럼 불변 트리거를 끄고 확정 Rev 셀을 바꿔도 version 은 그대로 (초안만 올리므로)
  alter table plan_cells disable trigger plan_cells_immutable;
  insert into plan_cells (revision_id, line_id, date, product_id) values (v_conf, v_line, '2099-01-03', v_p1);
  update plan_cells set qty = 7 where revision_id = v_conf;
  delete from plan_cells where revision_id = v_conf and date = '2099-01-03';
  alter table plan_cells enable trigger plan_cells_immutable;
  if (select version from plan_revisions where id = v_conf) <> v_conf_ver
     or (select updated_at from plan_revisions where id = v_conf) is distinct from v_conf_at then
    raise exception 'T13 실패: 확정 Rev 의 version·updated_at 이 바뀜';
  end if;

  -- save_plan_draft 로도 확정 Rev 는 confirmed, 셀 그대로
  select * into res from save_plan_draft(v_conf, v_conf_ver, null, '[]'::jsonb);
  if res.out_status <> 'confirmed' or res.out_rev_no <> 0 then raise exception 'T13 실패: status=% rev_no=%', res.out_status, res.out_rev_no; end if;
  select count(*) into n from plan_cells where revision_id = v_conf;
  if n <> 2 then raise exception 'T13 실패: 확정 Rev 셀 %개', n; end if;
  if (select version from plan_revisions where id = v_conf) <> v_conf_ver then raise exception 'T13 실패: 확정 Rev version 바뀜'; end if;
  perform pg_temp.selftest_pass(format('PASS T13 확정 Rev: 셀 넣기 거부, 트리거를 꺼도 version·updated_at 그대로, save_plan_draft → confirmed (Rev 0)'));

  -- T14 확정 Rev 가 있는 계획 삭제는 지금처럼 막힌다
  raised := false;
  begin
    delete from plans where id = v_plan;
  exception when others then raised := true;
  end;
  if not raised then raise exception 'T14 실패: 확정 Rev 가 있는 계획이 지워짐'; end if;
  perform pg_temp.selftest_pass(format('PASS T14 확정 Rev 가 있는 계획 삭제는 여전히 막힘'));

  -- T15 초안만 있는 계획 통째로 삭제(cascade) → 오류 없음
  insert into plans (factory_id, process_tab, period_start, period_end)
    values (v_factory, 'SELFTEST_0011', '2099-02-05', '2099-02-19') returning id into v_plan2;
  insert into plan_revisions (plan_id, status) values (v_plan2, 'draft') returning id into v_draft2;
  insert into plan_cells (revision_id, line_id, date, product_id) values (v_draft2, v_line, '2099-02-05', v_p1), (v_draft2, v_line, '2099-02-06', v_p1);
  delete from plans where id = v_plan2;
  if exists (select 1 from plan_revisions where id = v_draft2) or exists (select 1 from plan_cells where revision_id = v_draft2) then
    raise exception 'T15 실패: 계획 삭제 뒤 Rev·셀이 남음';
  end if;
  perform pg_temp.selftest_pass(format('PASS T15 초안만 있는 계획 삭제(cascade) 오류 없음, Rev·셀 함께 삭제'));

  perform pg_temp.selftest_pass(format('모든 시험 통과 (아래 rollback 으로 시험 데이터와 0011 변경이 모두 취소됩니다)'));
end $$;

-- 결과 표 (모든 시험이 통과했을 때만 보인다. 실패하면 위에서 「T? 실패」 오류로 멈춘다)
select no, item from selftest_0011_results order by no;

rollback;
