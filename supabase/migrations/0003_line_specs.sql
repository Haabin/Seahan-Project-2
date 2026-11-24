-- =====================================================================
-- 0003_line_specs.sql · 설비 상세 정보 (제조사·모델·도입일·취출·H/R·캐비티·B열 원문)
-- 현행 계획표: 설비 1대 = 3행(설비번호 / 제조사 / 모델), A열 메모(도입·취출·H/R), B열(생산 가능 제품 원문).
-- 기존 lines 테이블은 바꾸지 않고 1:1 테이블을 새로 둔다.
-- H/R·캐비티는 설비·H/R 단위로 여러 값·호환 정보가 섞여 있어(팀장님 확인 전) 글자로 저장한다.
-- RLS·감사 로그는 0001의 기준정보 패턴과 같다(로그인 사용자 읽기, admin 쓰기).
-- =====================================================================

create table if not exists line_specs (
  line_id uuid primary key references lines(id) on delete cascade,
  maker text,                    -- 제조사
  model text,                    -- 모델
  installed_on date,             -- 도입일 (정확한 날짜가 있을 때만)
  installed_note text,           -- 도입 원문 ('25.01월', '중고설비 구입' 등 날짜로 못 바꾸는 값)
  install_source text,           -- 도입처
  take_out text,                 -- 취출
  hot_runner text,               -- H/R
  cavity_note text,              -- 캐비티
  allowed_products_raw text,     -- B열 원문 (생산 가능 제품)
  memo text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table line_specs enable row level security;

drop policy if exists line_specs_read on line_specs;
create policy line_specs_read on line_specs for select using (auth.uid() is not null);
drop policy if exists line_specs_admin_write on line_specs;
create policy line_specs_admin_write on line_specs for all using (app_is_admin()) with check (app_is_admin());

-- audit_row()는 id/key 컬럼으로 row_id를 채운다. 이 테이블은 line_id가 키라 row_id는 비고, diff에 line_id가 남는다.
drop trigger if exists audit_line_specs on line_specs;
create trigger audit_line_specs after insert or update or delete on line_specs
  for each row execute function audit_row();
