-- =============================================
-- profiles: can_delete_reels 권한 추가 (2026-05-03)
-- 직원도 admin이 명시적으로 권한을 주면 릴스 DB 삭제 가능
-- =============================================

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_delete_reels BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
