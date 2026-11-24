-- 0003_api_grants 가 0006_purchase_review 보다 나중에 실행되는 DB(= 0006 을 이미 적용한 DB)에서는
-- 0003 의 "모든 테이블 쓰기 권한 부여"가 0006 의 회수를 되돌린다. 순서와 무관하게 같은 상태가 되도록 한 번 더 회수한다.
-- 발주의뢰서 쓰기는 save_purchase_review 함수(security definer)로만 한다. 여러 번 실행해도 결과가 같다.
revoke insert, update, delete, truncate on public.purchase_requests, public.purchase_request_items from public, anon, authenticated;
revoke all on public.purchase_request_history from public, anon, authenticated;
grant select on public.purchase_request_history to authenticated;
