-- =====================================================================
-- 0001_init.sql · 주간 생산계획 수립 지원 툴 · 기본 스키마
-- 표준 PostgreSQL 문법 위주. Supabase 의존은 auth.users 참조와 auth.uid()뿐이다(사내 이전 시 교체 지점).
-- 요구사항: FR-01~17, NFR-02(역할), NFR-08(확장성: 공정유형·공장 필드), NFR-09(Rev 보관)
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------- 열거형 ----------
do $$ begin
  create type process_type as enum ('PET1_1STAGE', 'PET2_INJ', 'PET2_BLOW', 'PE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type changeover_type as enum ('NONE', 'BM', 'FULL');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app_role as enum ('viewer', 'planner', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type revision_status as enum ('draft', 'confirmed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type reason_category as enum ('설비', '품질', '인원', '출고계획', '급발주', '기타');
exception when duplicate_object then null; end $$;

do $$ begin
  create type upload_kind as enum ('plan', 'master', 'shipment', 'inventory');
exception when duplicate_object then null; end $$;

do $$ begin
  create type receipt_status as enum ('planned', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

-- ---------- 사용자·역할 (NFR-02) ----------
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role app_role not null default 'viewer',
  team text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 역할 판별 함수: 인증 계층 교체 시 이 함수만 바꾼다
create or replace function app_role()
returns app_role
language sql stable security definer set search_path = public
as $$
  select coalesce((select role from profiles where user_id = auth.uid()), 'viewer'::app_role);
$$;

create or replace function app_can_write()
returns boolean language sql stable as $$ select app_role() in ('planner', 'admin') $$;

create or replace function app_is_admin()
returns boolean language sql stable as $$ select app_role() = 'admin' $$;

-- 신규 가입 시 profiles 자동 생성(기본 viewer). 가입 자체는 관리자가 대시보드에서 만든다.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- 기준정보 (FR-01) ----------
create table if not exists factories (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,          -- 'F1', 'F2'
  name text not null
);

create table if not exists lines (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references factories(id),
  code text unique not null,          -- 'PET1' … 'PET18', 'A1', 'P1' …
  name text not null,
  process_type process_type not null,
  uses_seabulk boolean not null default true,
  sort_order int not null default 0,
  is_plan_target boolean not null default false,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text unique not null,          -- 계획표 셀 제품명과 매칭(FR-03)
  cavity int,
  pack_unit int,
  preform_weight_g numeric(10,3) not null default 0,
  safety_stock numeric(14,0) not null default 0,          -- Q12
  surplus_days int,                                        -- null이면 settings.surplus_days
  default_daily_capa numeric(14,0) not null default 0,
  unit text not null default 'EA' check (unit in ('EA', 'KEA')), -- Q3
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists line_allowed_molds (
  line_id uuid not null references lines(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  primary key (line_id, product_id)
);

create table if not exists line_product_capacity (
  line_id uuid not null references lines(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  daily_capa numeric(14,0) not null,
  primary key (line_id, product_id)
);

create table if not exists changeover_coefficients (
  process_type process_type not null,
  changeover_type changeover_type not null check (changeover_type <> 'NONE'),
  hours numeric(5,2) not null default 0,
  factor numeric(5,3) not null default 1,
  next_day_start boolean not null default false,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (process_type, changeover_type)
);

-- 설정값: 9장 미확정 항목은 전부 여기(코드 하드코딩 금지)
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists priority_weights (
  key text primary key check (key in ('due_soon', 'major_customer', 'below_safety')),
  weight numeric(6,2) not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- ---------- 계획 (FR-02, FR-04, FR-06) ----------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references factories(id),
  process_tab text not null default '1STAGE',
  period_start date not null,         -- 목요일
  period_end date not null,           -- period_start + 14
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (factory_id, process_tab, period_start)
);

create table if not exists plan_revisions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  rev_no int,                          -- 초안은 null, 확정 시 0,1,2…
  status revision_status not null default 'draft',
  reason_category reason_category,
  reason_text text,
  parent_revision_id uuid references plan_revisions(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (plan_id, rev_no),
  -- FR-04: Rev 1 이상은 변경 사유 필수
  constraint reason_required check (
    status = 'draft' or rev_no = 0 or (reason_category is not null and coalesce(length(trim(reason_text)), 0) > 0)
  )
);

create table if not exists plan_cells (
  revision_id uuid not null references plan_revisions(id) on delete cascade,
  line_id uuid not null references lines(id),
  date date not null,
  product_id uuid references products(id),
  qty numeric(14,0),
  changeover_type changeover_type not null default 'NONE',
  memo text,
  primary key (revision_id, line_id, date)
);

create table if not exists downtimes (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references lines(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

-- ---------- 수요·재고 (FR-05) ----------
create table if not exists uploads (
  id uuid primary key default gen_random_uuid(),
  kind upload_kind not null,
  filename text not null,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now(),   -- 화면의 "데이터 기준 시각"
  row_count int not null default 0,
  warnings jsonb not null default '[]'::jsonb
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  is_major boolean not null default false
);

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  customer_id uuid references customers(id),
  ship_date date not null,
  qty numeric(14,0) not null,
  upload_id uuid references uploads(id) on delete set null
);
create index if not exists shipments_date_idx on shipments (ship_date);

create table if not exists inventory_snapshots (
  product_id uuid not null references products(id),
  as_of_date date not null,
  qty numeric(14,0) not null,
  upload_id uuid references uploads(id) on delete set null,
  primary key (product_id, as_of_date)
);

-- ---------- 씨벌크 원료 (FR-14~17) ----------
create table if not exists silos (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,          -- 'S55', 'S150'
  volume_m3 numeric(8,1) not null,
  max_ton numeric(8,1) not null
);

create table if not exists silo_stock_measurements (
  date date not null,
  silo_id uuid not null references silos(id),
  measured_ton numeric(8,2) not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (date, silo_id)
);

create table if not exists silo_receipts (
  id uuid primary key default gen_random_uuid(),
  supplier text not null,
  planned_date date not null,
  qty_ton numeric(8,2) not null,
  order_date date,
  status receipt_status not null default 'planned',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Q9: 계획 밖 사출 설비의 고정 사용량
create table if not exists silo_external_usage (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references factories(id),
  label text not null,
  weekday_ton numeric(8,2) not null default 0,
  weekend_ton numeric(8,2) not null default 0,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- 운용안 월별 물량 (3~6주 추정)
create table if not exists monthly_operation_plan (
  product_id uuid not null references products(id) on delete cascade,
  line_id uuid not null references lines(id) on delete cascade,
  year_month text not null check (year_month ~ '^\d{4}-\d{2}$'),
  qty numeric(14,0) not null,
  working_days int not null default 30,
  primary key (product_id, line_id, year_month)
);

-- ---------- 감사 로그 (FR-01 수정자·시각, NFR-02) ----------
create table if not exists audit_log (
  id bigserial primary key,
  table_name text not null,
  row_id text,
  action text not null,                -- INSERT / UPDATE / DELETE
  changed_by uuid,
  changed_at timestamptz not null default now(),
  diff jsonb
);

create or replace function audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (table_name, row_id, action, changed_by, diff)
  values (
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id',
             (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'key'),
    tg_op,
    auth.uid(),
    jsonb_build_object('old', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
                       'new', case when tg_op = 'DELETE' then null else to_jsonb(new) end)
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['lines','products','line_allowed_molds','line_product_capacity',
                           'changeover_coefficients','settings','priority_weights','silo_receipts',
                           'silo_external_usage','downtimes']
  loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function audit_row()', t);
  end loop;
end $$;

-- 확정 Rev 불변 (NFR-09)
create or replace function forbid_confirmed_change()
returns trigger language plpgsql as $$
declare rev_status revision_status;
begin
  select status into rev_status from plan_revisions where id = coalesce(new.revision_id, old.revision_id);
  if rev_status = 'confirmed' then
    raise exception '확정된 Rev의 계획 셀은 수정할 수 없습니다 (NFR-09)';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists plan_cells_immutable on plan_cells;
create trigger plan_cells_immutable
  before insert or update or delete on plan_cells
  for each row execute function forbid_confirmed_change();

create or replace function forbid_confirmed_revision_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.status = 'confirmed' then
    raise exception '확정된 Rev는 삭제할 수 없습니다 (NFR-09)';
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    raise exception '확정된 Rev는 수정할 수 없습니다 (NFR-09)';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists plan_revisions_immutable on plan_revisions;
create trigger plan_revisions_immutable
  before update or delete on plan_revisions
  for each row execute function forbid_confirmed_revision_change();

-- ---------- 기본값 ----------
insert into factories (code, name) values ('F1', '오창 1공장'), ('F2', '오창 2공장')
on conflict (code) do nothing;

insert into silos (code, volume_m3, max_ton) values ('S55', 55, 40), ('S150', 150, 120)
on conflict (code) do nothing;

insert into changeover_coefficients (process_type, changeover_type, hours, factor, next_day_start) values
  ('PET1_1STAGE', 'BM',   3, 0.87, false),
  ('PET1_1STAGE', 'FULL', 0, 0,    true),   -- 익일 가동: 교체일 생산 0
  ('PET2_INJ',    'BM',   2, 0.91, false),
  ('PET2_INJ',    'FULL', 4, 0.83, false),
  ('PET2_BLOW',   'BM',   2, 0.91, false),
  ('PET2_BLOW',   'FULL', 4, 0.83, false),
  ('PE',          'BM',   6, 0.75, false),
  ('PE',          'FULL', 6, 0.75, false)
on conflict (process_type, changeover_type) do nothing;

insert into settings (key, value, description) values
  ('weekend_factor',          '0.8',   'Q5 주말 계수(토·일). 평일 대비 비율'),
  ('daily_changeover_limit',  '3',     'Q4 공장 단위 하루 금형 교체 가능 횟수'),
  ('default_changeover_type', '"BM"',  '교체유형 미입력 시 적용할 기본 교체유형'),
  ('silo_lower_bound_ton',    '30',    'Q2 사일로 안전재고 하한(톤)'),
  ('silo_upper_bound_ton',    '160',   '사일로 합계 상한(톤) = 40 + 120'),
  ('lead_time_days',          '30',    '씨벌크 발주 리드타임(일)'),
  ('receipt_unit_ton',        '22',    '1회 입고 단위(톤)'),
  ('surplus_days',            '14',    '과잉 기준: 예상재고가 향후 N일 출고합을 넘으면 과잉'),
  ('qty_unit',                '"EA"',  'Q3 수량 단위 EA=본, KEA=천본')
on conflict (key) do nothing;

insert into priority_weights (key, weight) values
  ('due_soon', 3), ('major_customer', 2), ('below_safety', 1)
on conflict (key) do nothing;

-- ---------- RLS ----------
alter table profiles enable row level security;
alter table factories enable row level security;
alter table lines enable row level security;
alter table products enable row level security;
alter table line_allowed_molds enable row level security;
alter table line_product_capacity enable row level security;
alter table changeover_coefficients enable row level security;
alter table settings enable row level security;
alter table priority_weights enable row level security;
alter table plans enable row level security;
alter table plan_revisions enable row level security;
alter table plan_cells enable row level security;
alter table downtimes enable row level security;
alter table uploads enable row level security;
alter table customers enable row level security;
alter table shipments enable row level security;
alter table inventory_snapshots enable row level security;
alter table silos enable row level security;
alter table silo_stock_measurements enable row level security;
alter table silo_receipts enable row level security;
alter table silo_external_usage enable row level security;
alter table monthly_operation_plan enable row level security;
alter table audit_log enable row level security;

-- profiles: 본인 읽기, admin 전체
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles for select using (auth.uid() = user_id or app_is_admin());
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for all using (app_is_admin()) with check (app_is_admin());

-- 기준정보: 로그인 사용자 읽기, admin 쓰기
do $$
declare t text;
begin
  foreach t in array array['factories','lines','products','line_allowed_molds','line_product_capacity',
                           'changeover_coefficients','settings','priority_weights','silos','monthly_operation_plan','customers']
  loop
    execute format('drop policy if exists %1$s_read on %1$s', t);
    execute format('create policy %1$s_read on %1$s for select using (auth.uid() is not null)', t);
    execute format('drop policy if exists %1$s_admin_write on %1$s', t);
    execute format('create policy %1$s_admin_write on %1$s for all using (app_is_admin()) with check (app_is_admin())', t);
  end loop;
end $$;

-- 운용 데이터: 로그인 사용자 읽기, planner/admin 쓰기
do $$
declare t text;
begin
  foreach t in array array['plans','downtimes','uploads','shipments','inventory_snapshots',
                           'silo_stock_measurements','silo_receipts','silo_external_usage']
  loop
    execute format('drop policy if exists %1$s_read on %1$s', t);
    execute format('create policy %1$s_read on %1$s for select using (auth.uid() is not null)', t);
    execute format('drop policy if exists %1$s_write on %1$s', t);
    execute format('create policy %1$s_write on %1$s for all using (app_can_write()) with check (app_can_write())', t);
  end loop;
end $$;

-- 계획 Rev·셀: viewer는 확정본만, planner/admin은 전부 (FR-13)
drop policy if exists plan_revisions_read on plan_revisions;
create policy plan_revisions_read on plan_revisions for select
  using (auth.uid() is not null and (status = 'confirmed' or app_can_write()));
drop policy if exists plan_revisions_write on plan_revisions;
create policy plan_revisions_write on plan_revisions for all
  using (app_can_write()) with check (app_can_write());

drop policy if exists plan_cells_read on plan_cells;
create policy plan_cells_read on plan_cells for select
  using (auth.uid() is not null and exists (
    select 1 from plan_revisions r where r.id = plan_cells.revision_id and (r.status = 'confirmed' or app_can_write())
  ));
drop policy if exists plan_cells_write on plan_cells;
create policy plan_cells_write on plan_cells for all
  using (app_can_write()) with check (app_can_write());

-- 감사 로그: admin만 읽기
drop policy if exists audit_log_admin_read on audit_log;
create policy audit_log_admin_read on audit_log for select using (app_is_admin());
