-- 0009_purchase_admin_read.sql · 발주서를 올린 사람뿐 아니라 관리자(admin)도 볼 수 있게 한다
-- 읽기만 넓힌다. 검토본 수정·저장은 지금처럼 올린 사람만 한다(save_purchase_review 가 작성자를 확인한다).
-- 여러 번 실행해도 결과가 같다. 기존 정책(작성자 본인 읽기)은 그대로 둔다.

drop policy if exists purchase_requests_admin_read on public.purchase_requests;
create policy purchase_requests_admin_read on public.purchase_requests
  for select to authenticated using (public.app_is_admin());

drop policy if exists purchase_items_admin_read on public.purchase_request_items;
create policy purchase_items_admin_read on public.purchase_request_items
  for select to authenticated using (public.app_is_admin());

drop policy if exists purchase_history_admin_read on public.purchase_request_history;
create policy purchase_history_admin_read on public.purchase_request_history
  for select to authenticated using (public.app_is_admin());

-- 원본 파일(비공개 버킷)도 관리자가 내려받을 수 있다
drop policy if exists purchase_originals_admin_read on storage.objects;
create policy purchase_originals_admin_read on storage.objects
  for select to authenticated using (bucket_id = 'purchase-request-originals' and public.app_is_admin());
