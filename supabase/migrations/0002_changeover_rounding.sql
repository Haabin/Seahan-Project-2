-- =====================================================================
-- 0002_changeover_rounding.sql · 교체 손실 시간 → 가동률 자동 계산
-- 가동률 = (24 − 교체시간) / 24 를 아래 반올림 방식으로 맞춘다 (lib/engine/changeover.ts).
-- 기본 'floor2'(소수 둘째 자리 내림)는 현행 계수표 값(0.87, 0.91, 0.83, 0.75)을 그대로 재현한다.
-- 테이블 구조 변경 없음: settings 행 1개만 추가.
-- =====================================================================

insert into settings (key, value, description) values
  ('changeover_factor_rounding', '"floor2"',
   '교체 가동률 반올림 방식: floor2(둘째 자리 내림·기준표) / round2 / round3 / none')
on conflict (key) do nothing;
