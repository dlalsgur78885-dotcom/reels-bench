-- =============================================
-- profiles: Figma OAuth 토큰 컬럼 (2026-05-19)
-- 유저별 Figma access/refresh 토큰 저장 — Figma 디자인 import용
-- =============================================

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS figma_access_token  TEXT,
  ADD COLUMN IF NOT EXISTS figma_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS figma_token_exp     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS figma_user_id       TEXT,
  ADD COLUMN IF NOT EXISTS figma_handle        TEXT;

COMMIT;
