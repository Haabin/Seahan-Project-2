-- =====================================================================
-- 0003_api_grants.sql · API 역할 권한
-- 새로 만든 Supabase 프로젝트는 public 스키마 테이블에 대한 SELECT/INSERT/UPDATE/DELETE 를
-- API 역할에 자동으로 주지 않는다(예전 프로젝트는 자동으로 줬다). 권한이 없으면 화면·업로드·계정 스크립트가
-- "permission denied for table …" 로 실패한다.
-- 로그인 사용자(authenticated)와 서버 전용 키(service_role)에만 준다. 실제 접근 범위는 RLS 정책이 정한다.
-- 로그인 전(anon)에는 주지 않는다. 이미 권한이 있는 프로젝트에서 다시 실행해도 안전하다.
-- =====================================================================
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- 앞으로 만드는 테이블에도 같은 권한
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

-- 적용 이력 테이블은 스크립트(DATABASE_URL)만 쓴다
do $$ begin
  if to_regclass('public._migrations') is not null then
    revoke all on table _migrations from authenticated, service_role, anon;
  end if;
end $$;
