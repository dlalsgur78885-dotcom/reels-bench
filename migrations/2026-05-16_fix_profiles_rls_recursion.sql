-- =============================================
-- profiles RLS 무한 재귀 수정 (2026-05-16)
--
-- 문제: "admins read all profiles" / "admins manage profiles" 정책이
--   EXISTS (SELECT FROM profiles p WHERE ... role = 'admin') 패턴이라
--   profiles 읽을 때마다 같은 정책이 재평가되며 무한 재귀.
--   에러: 42P17 "infinite recursion detected in policy for relation profiles"
--
-- 해결: SECURITY DEFINER 함수로 admin 체크를 캡슐화 → 함수 내부 쿼리는
--   호출자 RLS를 무시하므로 재귀 끊김.
-- =============================================

BEGIN;

-- 1. SECURITY DEFINER 헬퍼 — 호출자 권한이 아닌 함수 owner 권한으로 실행
--    → 내부 profiles SELECT가 RLS를 우회
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND role = 'admin'
  );
$$;

-- 함수 실행 권한
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO anon, authenticated, service_role;

-- 2. 기존 재귀 정책 제거 후 재생성
DROP POLICY IF EXISTS "users read own profile" ON public.profiles;
DROP POLICY IF EXISTS "admins read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "users update own profile" ON public.profiles;
DROP POLICY IF EXISTS "admins manage profiles" ON public.profiles;

-- 본인 SELECT
CREATE POLICY "users read own profile" ON public.profiles
  FOR SELECT
  USING (id = auth.uid());

-- admin SELECT (재귀 없는 함수 사용)
CREATE POLICY "admins read all profiles" ON public.profiles
  FOR SELECT
  USING (public.is_admin(auth.uid()));

-- 본인 UPDATE (role 변경 금지)
CREATE POLICY "users update own profile" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

-- admin은 모든 작업 (INSERT/UPDATE/DELETE)
CREATE POLICY "admins manage profiles" ON public.profiles
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- 3. (선택) 다른 테이블 정책도 같은 패턴이면 함수로 갈아끼우는 게 안전.
--    script_gen_events 정책도 동일 패턴이지만 profiles 자체가 아닌 다른 테이블 ON 절이라
--    재귀는 안 생긴다. 그래도 통일하면 좋음:
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.script_gen_events'::regclass
      AND polname = 'admin select all'
  ) THEN
    DROP POLICY "admin select all" ON public.script_gen_events;
    CREATE POLICY "admin select all" ON public.script_gen_events
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END $$;

COMMIT;
