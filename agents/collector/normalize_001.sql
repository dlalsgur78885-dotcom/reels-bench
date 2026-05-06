-- =============================================
-- Normalize 001 — 무결성 + 중복 컬럼 제거 (2026-04-29)
-- 적용: Supabase SQL Editor에 통째로 붙여넣고 실행
-- =============================================

BEGIN;

-- 1. shortcode 형식 CHECK (8~22자 영숫자/_/-)
--    이미 잘못된 행은 사전에 삭제 완료 (백엔드 스크립트에서 수행)
ALTER TABLE reels
  ADD CONSTRAINT reels_shortcode_format
  CHECK (shortcode ~ '^[A-Za-z0-9_-]{5,22}$');

-- 2. reels_comments 중복 방지
--    (shortcode, comment_author, comment_text) 조합 UNIQUE
--    이미 중복 행은 사전 삭제 완료
ALTER TABLE reels_comments
  ADD CONSTRAINT reels_comments_unique_triple
  UNIQUE (shortcode, comment_author, comment_text);

-- 3. 중복 컬럼 제거 — canonical은 reels_metadata
ALTER TABLE reels DROP COLUMN IF EXISTS author;
ALTER TABLE reels DROP COLUMN IF EXISTS caption;
ALTER TABLE reels_transcripts DROP COLUMN IF EXISTS duration_seconds;

-- 4. 사용 안 하는 컬럼 정리
ALTER TABLE reels_comments DROP COLUMN IF EXISTS commented_at;

COMMIT;
