-- 0008_order_intake_link.sql · 발주서 접수(purchase_requests) → 주문(orders) 연결
-- 여러 번 실행해도 결과가 같다. 기존 행은 바꾸지 않는다.

-- ---------- 발주서 품번 → 생산계획 제품 연결 (사람이 한 번 확정하면 다음부터 자동으로 채운다) ----------
-- 발주서의 품번(TM00648 등)과 생산계획 제품(products.code)은 체계가 달라 자동으로 이어지지 않는다.
create table if not exists purchase_product_links (
  product_code text primary key,                                   -- 발주서 품번 (앞뒤 공백 정리, 대문자)
  product_id uuid not null references products(id) on delete cascade,
  product_name_raw text,                                           -- 연결할 때의 발주서 품명 (참고용)
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index if not exists purchase_product_links_product_idx on purchase_product_links (product_id);

alter table purchase_product_links enable row level security;
drop policy if exists purchase_product_links_read on purchase_product_links;
create policy purchase_product_links_read on purchase_product_links for select using (auth.uid() is not null);
drop policy if exists purchase_product_links_write on purchase_product_links;
create policy purchase_product_links_write on purchase_product_links for all using (app_can_write()) with check (app_can_write());
grant select, insert, update, delete on purchase_product_links to authenticated, service_role;

-- ---------- 주문이 어느 발주서의 몇 번째 품목에서 왔는지 ----------
-- 발주서를 다시 보내면 같은 주문을 고친다(새로 만들지 않는다). 발주서를 지워도 주문은 남는다.
alter table orders add column if not exists purchase_request_id uuid references purchase_requests(id) on delete set null;
alter table orders add column if not exists purchase_line int;
create unique index if not exists orders_purchase_line_idx on orders (purchase_request_id, purchase_line) where purchase_request_id is not null;
