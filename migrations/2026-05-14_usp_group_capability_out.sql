-- usp_groups에 capability_out 컬럼 추가 — 그룹 단위 "안 하는 것" 명시
-- 실행: Supabase SQL Editor

ALTER TABLE usp_groups
  ADD COLUMN IF NOT EXISTS capability_out text;

COMMENT ON COLUMN usp_groups.capability_out IS
  '이 USP 그룹이 안 하는 것 (writer가 false claim 회피용). 콤마 구분. 예: "실제 예약 (제휴 사이트), 결제 (외부 처리)"';
