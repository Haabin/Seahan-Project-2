create table if not exists public.purchase_requests (
 id uuid primary key default gen_random_uuid(),
 request_number text not null,
 customer_id uuid references public.customers(id) on delete set null,
 customer_name text not null default '',
 status text not null default 'draft' check(status in ('draft','confirmed')),
 owner_id uuid not null references auth.users(id),
 original_file_name text not null,
 original_file_path text not null unique,
 original_file_type text not null,
 original_file_size bigint not null check(original_file_size between 1 and 10485760),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.purchase_request_items (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.purchase_requests(id) on delete cascade,
 line_number integer not null check(line_number > 0),
 product_id uuid references public.products(id) on delete set null,
 product_code text not null default '',
 product_name text not null default '',
 quantity numeric not null check(quantity > 0),
 unit text not null default 'EA',
 requested_date date,
 customer_name text not null default '',
 note text not null default '',
 unique(request_id,line_number),
 check(length(trim(product_code)) > 0 or length(trim(product_name)) > 0)
);
create index if not exists purchase_requests_owner_idx on public.purchase_requests(owner_id,created_at desc);
create index if not exists purchase_request_items_request_idx on public.purchase_request_items(request_id);
alter table public.purchase_requests enable row level security;
alter table public.purchase_request_items enable row level security;
drop policy if exists purchase_requests_owner_read on public.purchase_requests;
create policy purchase_requests_owner_read on public.purchase_requests for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists purchase_requests_owner_insert on public.purchase_requests;
create policy purchase_requests_owner_insert on public.purchase_requests for insert to authenticated with check(owner_id=(select auth.uid()) and app_can_write());
drop policy if exists purchase_requests_owner_update on public.purchase_requests;
create policy purchase_requests_owner_update on public.purchase_requests for update to authenticated using(owner_id=(select auth.uid()) and app_can_write()) with check(owner_id=(select auth.uid()) and app_can_write());
drop policy if exists purchase_requests_owner_delete on public.purchase_requests;
create policy purchase_requests_owner_delete on public.purchase_requests for delete to authenticated using(owner_id=(select auth.uid()) and app_can_write());
drop policy if exists purchase_items_owner_read on public.purchase_request_items;
create policy purchase_items_owner_read on public.purchase_request_items for select to authenticated using(exists(select 1 from public.purchase_requests p where p.id=request_id and p.owner_id=(select auth.uid())));
drop policy if exists purchase_items_owner_insert on public.purchase_request_items;
create policy purchase_items_owner_insert on public.purchase_request_items for insert to authenticated with check(app_can_write() and exists(select 1 from public.purchase_requests p where p.id=request_id and p.owner_id=(select auth.uid())));
drop policy if exists purchase_items_owner_update on public.purchase_request_items;
create policy purchase_items_owner_update on public.purchase_request_items for update to authenticated using(app_can_write() and exists(select 1 from public.purchase_requests p where p.id=request_id and p.owner_id=(select auth.uid()))) with check(app_can_write() and exists(select 1 from public.purchase_requests p where p.id=request_id and p.owner_id=(select auth.uid())));
drop policy if exists purchase_items_owner_delete on public.purchase_request_items;
create policy purchase_items_owner_delete on public.purchase_request_items for delete to authenticated using(app_can_write() and exists(select 1 from public.purchase_requests p where p.id=request_id and p.owner_id=(select auth.uid())));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('purchase-request-originals','purchase-request-originals',false,10485760,array['text/csv','application/json','application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists purchase_originals_owner_read on storage.objects;
create policy purchase_originals_owner_read on storage.objects for select to authenticated using(bucket_id='purchase-request-originals' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists purchase_originals_owner_insert on storage.objects;
create policy purchase_originals_owner_insert on storage.objects for insert to authenticated with check(bucket_id='purchase-request-originals' and (storage.foldername(name))[1]=(select auth.uid())::text and app_can_write());
drop policy if exists purchase_originals_owner_delete on storage.objects;
create policy purchase_originals_owner_delete on storage.objects for delete to authenticated using(bucket_id='purchase-request-originals' and (storage.foldername(name))[1]=(select auth.uid())::text and app_can_write());
grant select,insert,update,delete on public.purchase_requests,public.purchase_request_items to authenticated;
