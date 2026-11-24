-- =====================================================================
-- 0010_plan_delete_admin_audit.sql · 초안 계획 삭제: admin 만 + 감사 기록
-- - plans 의 삭제는 admin 만. 만들기·수정(insert/update)은 지금처럼 planner·admin.
--   (0001 의 plans_write 는 for all 이었다 → insert / update / delete 로 나눈다. 읽기 정책 plans_read 는 그대로)
-- - 계획을 지우면 누가·언제·어떤 기간을 지웠는지 audit_log 에 남긴다(기존 audit_row() 재사용).
-- - 확정 Rev 가 있는 계획은 여전히 plan_revisions_immutable 트리거가 삭제를 막는다(NFR-09).
-- 여러 번 실행해도 결과가 같다.
-- 되돌리기:
--   drop policy if exists plans_insert on plans; drop policy if exists plans_update on plans; drop policy if exists plans_delete on plans;
--   create policy plans_write on plans for all using (app_can_write()) with check (app_can_write());
--   drop trigger if exists audit_plans on plans;
-- =====================================================================

drop policy if exists plans_write on plans;

drop policy if exists plans_insert on plans;
create policy plans_insert on plans for insert with check (app_can_write());

drop policy if exists plans_update on plans;
create policy plans_update on plans for update using (app_can_write()) with check (app_can_write());

drop policy if exists plans_delete on plans;
create policy plans_delete on plans for delete using (app_is_admin());

drop trigger if exists audit_plans on plans;
create trigger audit_plans after delete on plans
  for each row execute function audit_row();
