-- =====================================================================
-- 0004_plan_cell_order.sql · 계획 셀 ↔ 주문 연결
-- 초안 자동 생성이 만든 셀에 "어느 주문 때문에 만든 셀인지"를 남긴다.
-- 주문을 삭제·취소하면 그 주문으로 만든 초안 셀(사람이 고치지 않은 것)을 함께 지울 수 있다.
-- 주문이 지워져도 확정 Rev 의 셀은 그대로 남아야 하므로 FK 는 걸지 않는다(값만 보관).
-- =====================================================================
alter table plan_cells add column if not exists order_id uuid;
create index if not exists plan_cells_order_idx on plan_cells (order_id) where order_id is not null;
