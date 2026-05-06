-- =============================================
-- Supabase Vault 기반 시크릿 관리 (2026-05-01)
-- 라이브 서버에서 admin이 키를 직접 갱신할 수 있도록 함.
-- vault 스키마는 PostgREST에 노출하지 않고, SECURITY DEFINER 함수로 우회.
-- =============================================

BEGIN;

-- Vault extension 활성화 (Supabase에서 기본 제공, 안 켜져 있으면 켜기)
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- ── 시크릿 조회 (read-only)
CREATE OR REPLACE FUNCTION public.get_secret(secret_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  result text;
BEGIN
  SELECT decrypted_secret INTO result
  FROM vault.decrypted_secrets
  WHERE name = secret_name
  LIMIT 1;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_secret(text) TO service_role;

-- ── 시크릿 메타정보 목록 (값은 노출 안 함, 이름·설명·갱신일만)
CREATE OR REPLACE FUNCTION public.list_secret_names()
RETURNS TABLE(id uuid, name text, description text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.name, COALESCE(s.description, '') AS description, s.updated_at
  FROM vault.secrets s
  ORDER BY s.name;
END;
$$;

REVOKE ALL ON FUNCTION public.list_secret_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_secret_names() TO service_role;

-- ── 시크릿 생성/갱신
CREATE OR REPLACE FUNCTION public.upsert_secret(
  secret_name text,
  secret_value text,
  secret_description text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  existing_id uuid;
  result_id uuid;
BEGIN
  SELECT id INTO existing_id FROM vault.secrets WHERE name = secret_name LIMIT 1;
  IF existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(existing_id, secret_value, secret_name, secret_description);
    result_id := existing_id;
  ELSE
    SELECT vault.create_secret(secret_value, secret_name, secret_description) INTO result_id;
  END IF;
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_secret(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_secret(text, text, text) TO service_role;

-- ── 시크릿 삭제
CREATE OR REPLACE FUNCTION public.delete_secret(secret_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  existing_id uuid;
BEGIN
  SELECT id INTO existing_id FROM vault.secrets WHERE name = secret_name LIMIT 1;
  IF existing_id IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM vault.secrets WHERE id = existing_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_secret(text) TO service_role;

COMMIT;

-- =============================================
-- 사용 예 (psql 또는 Supabase SQL Editor — service_role 컨텍스트 필요)
-- =============================================
-- 등록:    SELECT public.upsert_secret('GEMINI_API_KEY', 'AIzaSy...', 'Gemini Pro API key');
-- 조회:    SELECT public.get_secret('GEMINI_API_KEY');
-- 목록:    SELECT * FROM public.list_secret_names();
-- 삭제:    SELECT public.delete_secret('GEMINI_API_KEY');
