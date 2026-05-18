-- my_products에 capability_out 컬럼 추가 — 상품 단위 "안 하는 것" 명시 (writer 환각 차단)
-- 실행: Supabase SQL Editor

ALTER TABLE my_products
  ADD COLUMN IF NOT EXISTS capability_out text;

COMMENT ON COLUMN my_products.capability_out IS
  '이 상품이 절대 하지 않는 기능 목록 (writer false claim 차단용). 콤마 구분.
   예: "예약, 결제, 환불, 다국어, 그룹 공유". USP 그룹 capability_out보다 강한 우선순위 (전체 상품 baseline).';
