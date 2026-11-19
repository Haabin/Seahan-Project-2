-- =====================================================================
-- 0002_inventory_baedae_draft.sql · v0.4
--   ① 재고현황(제품수불표)  ② 과거 생산배대 가져오기  ③ 생산계획 초안 자동 생성(금형 배정)
-- 0001 은 고치지 않는다. 확정 Rev 불변 트리거(NFR-09)는 그대로 둔다.
-- 다시 실행해도 안전하도록 if not exists / on conflict 를 쓴다.
-- =====================================================================

-- ---------- 열거형 확장 ----------
-- (새 값은 같은 트랜잭션에서 쓰지 않는다)
alter type upload_kind add value if not exists 'stock_ledger';
alter type upload_kind add value if not exists 'baedae';
alter type upload_kind add value if not exists 'orders';

-- ---------- ① 재고현황 (제품수불표) ----------
-- 품목 식별: 품번이 있으면 품번, 없으면 구간+공정+호기 라벨+품명(+같은 이름 순번)
create table if not exists stock_items (
  id uuid primary key default gen_random_uuid(),
  section text not null default '',        -- 소계 구간: 'PS', 'B2C', 'PE', '1211', '1219' (원본의 'OO 계' 행 기준)
  process text not null default '',        -- A열 공정: 'P S', '1211', '1212', '1219'
  machine_label text not null default '',  -- B열 호기 라벨: 'BNP', '대림', 'B M', 'S7' … (lines 와 강제 매칭하지 않는다)
  item_code text,                          -- C열 품번 (없을 수 있음)
  name text not null,                      -- D열 품명/규격 (앞뒤 공백 정리)
  dup_index int not null default 0,        -- 같은 구간에 같은 품명이 두 번 나오면 0, 1, …
  pack_unit numeric(12,2),                 -- J열 unit (포장 단위당 본수)
  units_per_pallet numeric(12,2),          -- K열 UNIT수/P
  product_id uuid references products(id) on delete set null, -- 생산계획 제품 연결 (수동 확정)
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (section, process, machine_label, name, dup_index)
);
create index if not exists stock_items_product_idx on stock_items (product_id);

create table if not exists stock_ledger_months (
  item_id uuid not null references stock_items(id) on delete cascade,
  year_month text not null check (year_month ~ '^\d{4}-\d{2}$'),
  opening_qty numeric(14,0) not null default 0,   -- 기초재고
  sort_order int not null default 0,              -- 그 달 표에서의 행 순서
  upload_id uuid references uploads(id) on delete set null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (item_id, year_month)
);

create table if not exists stock_ledger_days (
  item_id uuid not null references stock_items(id) on delete cascade,
  date date not null,
  produced numeric(14,0) not null default 0,      -- 음수 허용(원본에 보정 값이 있다)
  shipped numeric(14,0) not null default 0,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (item_id, date)
);
create index if not exists stock_ledger_days_date_idx on stock_ledger_days (date);

-- 수불표 → inventory_snapshots 동기화.
-- 제품에 연결된 품목만 대상. 전월 말일(=기초재고)과, 그 달 1일부터 "입력이 있는 마지막 날"까지의 일자별 현재고를 써넣는다.
-- 반환값: 써넣은 스냅샷 행 수
create or replace function sync_inventory_from_ledger(p_year_month text)
returns int
language plpgsql
as $$
declare
  v_start date := to_date(p_year_month || '-01', 'YYYY-MM-DD');
  v_end date := (v_start + interval '1 month' - interval '1 day')::date;
  v_last date;
  v_count int := 0;
begin
  select max(d.date) into v_last
  from stock_ledger_days d
  join stock_items i on i.id = d.item_id
  where i.product_id is not null and d.date between v_start and v_end
    and (d.produced <> 0 or d.shipped <> 0);

  -- 그 달에 이 함수가 예전에 써넣은 값은 지우고 다시 만든다 (업로드 출처가 있는 수불일보 스냅샷은 건드리지 않음)
  delete from inventory_snapshots s
  where s.upload_id is null
    and s.as_of_date between v_start - 1 and v_end
    and s.product_id in (select product_id from stock_items where product_id is not null);

  with base as (
    select i.product_id, i.id as item_id, m.opening_qty
    from stock_items i
    join stock_ledger_months m on m.item_id = i.id and m.year_month = p_year_month
    where i.product_id is not null
  ),
  days as (
    select generate_series(v_start - 1, coalesce(v_last, v_start - 1), interval '1 day')::date as d
  ),
  bal as (
    select b.product_id, days.d,
           sum(b.opening_qty + coalesce((
             select sum(x.produced - x.shipped) from stock_ledger_days x
             where x.item_id = b.item_id and x.date between v_start and days.d
           ), 0)) as qty
    from base b cross join days
    group by b.product_id, days.d
  )
  insert into inventory_snapshots (product_id, as_of_date, qty, upload_id)
  select product_id, d, qty, null from bal
  on conflict (product_id, as_of_date) do update set qty = excluded.qty, upload_id = null;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------- ② 생산배대 가져오기 ----------
-- 설비·일자별 원료(씨벌크) 소비량, 톤 (생산2_PET 시트 사출 설비 행 숫자. OPEN_QUESTIONS Q1 확정)
create table if not exists line_resin_usage (
  line_id uuid not null references lines(id) on delete cascade,
  date date not null,
  ton numeric(8,2) not null,
  upload_id uuid references uploads(id) on delete set null,
  primary key (line_id, date)
);

-- Rev 출처(가져온 파일 이름, 파일의 Rev 표기)
alter table plan_revisions add column if not exists source text;

-- 2공장 사출 P5 (생산2_PET 시트에 있음)
insert into lines (factory_id, code, name, process_type, uses_seabulk, sort_order, is_plan_target)
select f.id, 'P5', '2공장 사출 P5', 'PET2_INJ', true, 12, false from factories f where f.code = 'F2'
on conflict (code) do nothing;

-- ---------- ③ 금형 모델 (A안) ----------
create table if not exists molds (
  id uuid primary key default gen_random_uuid(),
  mold_no text unique not null,            -- 금형번호
  name text not null,                      -- 금형명 (생산배대 B열 이름 체계)
  cavity int,
  status text not null default 'active' check (status in ('active', 'repair', 'retired')),
  memo text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists mold_products (
  mold_id uuid not null references molds(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  primary key (mold_id, product_id)
);
create index if not exists mold_products_product_idx on mold_products (product_id);

-- 기존 제품마다 1:1 금형을 만든다(금형번호 = 제품 코드). 허용 금형 제약(line_allowed_molds)은 제품 기준 그대로.
insert into molds (mold_no, name, cavity)
select p.code, p.name, p.cavity from products p
on conflict (mold_no) do nothing;

insert into mold_products (mold_id, product_id)
select m.id, p.id from products p join molds m on m.mold_no = p.code
on conflict do nothing;

-- 계획 셀: 금형, 출처, 근거
alter table plan_cells add column if not exists mold_id uuid references molds(id);
alter table plan_cells add column if not exists origin text not null default 'manual';
alter table plan_cells add column if not exists basis text;
do $$ begin
  alter table plan_cells add constraint plan_cells_origin_check check (origin in ('auto', 'manual', 'imported'));
exception when duplicate_object then null; end $$;

-- ---------- 주문 ----------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no text,
  product_id uuid references products(id) on delete set null,   -- 매칭 안 되면 null (초안에서 제외)
  product_name_raw text not null,
  item_code_raw text,
  customer_id uuid references customers(id) on delete set null,
  customer_name_raw text,
  qty numeric(14,0) not null check (qty > 0),
  due_date date not null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  memo text,
  upload_id uuid references uploads(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_due_idx on orders (due_date);

-- ---------- 교체 시간·계수 (사용자 확정: 전 공정 Full 6h / B/M 2h) ----------
insert into settings (key, value, description) values
  ('changeover_hour_factor_table',
   '{"1":0.96,"2":0.915,"3":0.875,"4":0.83,"5":0.79,"6":0.75,"7":0.71,"8":0.67,"9":0.625}',
   '교체 손실 시간(h) → 가동률 계수 환산표 (생산배대 범례). 교체 시간을 바꾸면 이 표의 계수가 적용된다'),
  ('baedae_arrow_min_cover',      '0.5',        '생산배대 화살표가 날짜 칸을 이 비율 이상 덮으면 생산일로 센다'),
  ('baedae_arrow_ambiguous',      '[0.3, 0.7]', '화살표 덮는 비율이 이 범위면 포함하되 경고를 남긴다'),
  ('draft_history_weeks',         '8',          '초안 자동 생성이 참고하는 과거 확정 계획 기간(주)'),
  ('draft_use_net_requirement',   'true',       '초안 자동 생성: 순 소요량(주문 − (현재고 − 안전재고)) 사용 여부 기본값')
on conflict (key) do nothing;

update changeover_coefficients
   set hours = 6, factor = 0.75, next_day_start = false, updated_at = now()
 where changeover_type = 'FULL';
update changeover_coefficients
   set hours = 2, factor = 0.915, next_day_start = false, updated_at = now()
 where changeover_type = 'BM';

-- ---------- 감사 로그 ----------
do $$
declare t text;
begin
  foreach t in array array['stock_items', 'molds', 'orders']
  loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function audit_row()', t);
  end loop;
end $$;

-- ---------- RLS ----------
alter table stock_items enable row level security;
alter table stock_ledger_months enable row level security;
alter table stock_ledger_days enable row level security;
alter table line_resin_usage enable row level security;
alter table molds enable row level security;
alter table mold_products enable row level security;
alter table orders enable row level security;

-- 운용 데이터: 로그인 사용자 읽기, planner/admin 쓰기 (0001 과 같은 규칙)
do $$
declare t text;
begin
  foreach t in array array['stock_items', 'stock_ledger_months', 'stock_ledger_days', 'line_resin_usage',
                           'molds', 'mold_products', 'orders']
  loop
    execute format('drop policy if exists %1$s_read on %1$s', t);
    execute format('create policy %1$s_read on %1$s for select using (auth.uid() is not null)', t);
    execute format('drop policy if exists %1$s_write on %1$s', t);
    execute format('create policy %1$s_write on %1$s for all using (app_can_write()) with check (app_can_write())', t);
  end loop;
end $$;

-- 생산배대 매칭 화면에서 planner 가 새 제품을 "등록"만 할 수 있게 한다(수정·삭제는 여전히 admin).
drop policy if exists products_writer_insert on products;
create policy products_writer_insert on products for insert with check (app_can_write());
drop policy if exists line_allowed_molds_writer_insert on line_allowed_molds;
create policy line_allowed_molds_writer_insert on line_allowed_molds for insert with check (app_can_write());
