-- =====================================================================
-- 0004_lost_hours_override.sql · 비가동 시간 → 가동률 기준표 + 칸별 비가동 시간 직접 입력
-- 회의 확인: 가동률은 공식 (24 − h)/24 가 아니라 주간계획표 '생산1_1STAGE' I65:J73 기준표를 쓰고,
--           계산에는 소수 둘째 자리 내림 값을 쓴다 (lib/engine/changeover.ts rateFromLostHours).
-- 기존 행은 바꾸지 않는다: 열 추가(값 없음) + 설정 1행 추가 + 예전 반올림 설정 설명만 갱신.
-- =====================================================================

-- 칸별 비가동 시간 직접 입력 (0~24 정수, 비우면 교체유형 기준 시간)
alter table plan_cells add column if not exists lost_hours_override smallint
  check (lost_hours_override is null or lost_hours_override between 0 and 24);
comment on column plan_cells.lost_hours_override is
  '그날 전체 비가동 시간(h). 값이 있으면 교체유형 기준 시간 대신 사용';

-- 비가동 시간 → 가동률 기준표 (원본 값 그대로, 계산 시 둘째 자리 내림)
insert into settings (key, value, description) values
  ('changeover_factor_table',
   '[{"hours":1,"rate":0.96},{"hours":2,"rate":0.915},{"hours":3,"rate":0.875},{"hours":4,"rate":0.83},{"hours":5,"rate":0.79},{"hours":6,"rate":0.75},{"hours":7,"rate":0.71},{"hours":8,"rate":0.67},{"hours":9,"rate":0.625}]',
   '비가동 시간 → 가동률 기준표 (주간계획표 I65:J73 원본). 계산에는 둘째 자리 내림 값 사용')
on conflict (key) do nothing;

-- 예전 반올림 설정은 지우지 않고 사용 중지 표시만 (팀원 DB 호환)
update settings set description = '사용 안 함 (0004부터 changeover_factor_table 기준표 사용)'
 where key = 'changeover_factor_rounding';
