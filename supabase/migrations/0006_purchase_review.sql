alter table public.purchase_requests add column if not exists revision integer not null default 0;
create unique index if not exists purchase_request_number_per_owner on public.purchase_requests(owner_id, lower(trim(request_number)));
create table if not exists public.purchase_request_history (
  request_id uuid not null references public.purchase_requests(id) on delete cascade,
  revision integer not null,
  saved_at timestamptz not null default now(),
  request_number text not null,
  customer_name text not null,
  items jsonb not null,
  primary key(request_id,revision)
);
alter table public.purchase_request_history enable row level security;
drop policy if exists purchase_history_owner on public.purchase_request_history;
create policy purchase_history_owner on public.purchase_request_history for select to authenticated
using (exists(select 1 from public.purchase_requests r where r.id=request_id and r.owner_id=auth.uid()));
revoke all on public.purchase_request_history from public,anon,authenticated;
grant select on public.purchase_request_history to authenticated;
revoke insert,update,delete,truncate on public.purchase_requests,public.purchase_request_items from public,anon,authenticated;

create or replace function public.save_purchase_review(p_id uuid,p_revision integer,p_number text,p_customer text,p_file jsonb,p_items jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  current_revision integer;
  next_revision integer;
begin
  if actor is null or public.app_role() not in ('admin','planner') then raise exception '작성 권한이 필요합니다.'; end if;
  if nullif(trim(p_number),'') is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000 then raise exception '번호와 품목을 확인하세요.'; end if;
  if exists(select from jsonb_array_elements(p_items) i where
    coalesce(trim(i->>'productCode'),'')='' or coalesce(trim(i->>'productName'),'')='' or
    coalesce(nullif(trim(i->>'customer'),''),nullif(trim(p_customer),'')) is null or
    jsonb_typeof(i->'quantity') is distinct from 'number' or (i->>'quantity')::numeric <= 0 or
    coalesce(i->>'requestedDate','') !~ '^\d{4}-\d{2}-\d{2}$') then raise exception '필수 품목 정보 또는 수량 오류'; end if;
  if exists(select from jsonb_array_elements(p_items) i group by i having count(*)>1) then raise exception '중복 품목 행을 확인하세요.'; end if;
  select revision into current_revision from public.purchase_requests where id=p_id and owner_id=actor for update;
  if not found then
    if p_revision<>0 or p_file is null or split_part(p_file->>'path','/',1) is distinct from actor::text
      or not exists(select from storage.objects where bucket_id='purchase-request-originals' and name=p_file->>'path') then raise exception '원본을 확인하세요.'; end if;
    insert into public.purchase_requests(id,owner_id,request_number,customer_name,status,original_file_name,original_file_path,original_file_type,original_file_size)
      values(p_id,actor,trim(p_number),coalesce(p_customer,''),'confirmed',p_file->>'name',p_file->>'path',p_file->>'type',(p_file->>'size')::bigint);
    current_revision:=0;
  elsif p_revision is distinct from current_revision then raise exception '다른 수정본이 저장됐습니다. 문서를 다시 열어 주세요.';
  end if;
  next_revision:=current_revision+1;
  update public.purchase_requests set revision=next_revision,updated_at=now(),status='confirmed',request_number=trim(p_number),customer_name=coalesce(p_customer,'') where id=p_id;
  delete from public.purchase_request_items where request_id=p_id;
  insert into public.purchase_request_items(request_id,line_number,product_code,product_name,quantity,unit,requested_date,customer_name,note)
  select p_id,n,i->>'productCode',i->>'productName',(i->>'quantity')::numeric,coalesce(i->>'unit',''),(i->>'requestedDate')::date,coalesce(nullif(i->>'customer',''),p_customer,''),coalesce(i->>'note','')
  from jsonb_array_elements(p_items) with ordinality as t(i,n);
  insert into public.purchase_request_history(request_id,revision,request_number,customer_name,items) values(p_id,next_revision,trim(p_number),coalesce(p_customer,''),p_items);
  return next_revision;
end $$;
revoke all on function public.save_purchase_review(uuid,integer,text,text,jsonb,jsonb) from public,anon;
grant execute on function public.save_purchase_review(uuid,integer,text,text,jsonb,jsonb) to authenticated;
