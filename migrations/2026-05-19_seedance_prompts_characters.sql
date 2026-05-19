-- 프롬프트 / 인물 라이브러리 (영상 생성 재사용용)
-- 실행: Supabase SQL Editor 또는 Management API

-- 프롬프트
CREATE TABLE IF NOT EXISTS seedance_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name text,
  content text NOT NULL,
  mode text,                       -- 'transition' | 'reference' | null
  use_count int NOT NULL DEFAULT 0,
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_seedance_prompts_user
  ON seedance_prompts(created_by, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE seedance_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner all" ON seedance_prompts;
CREATE POLICY "owner all" ON seedance_prompts
  FOR ALL TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "admin select" ON seedance_prompts;
CREATE POLICY "admin select" ON seedance_prompts
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );


-- 인물 (캐릭터 사진 라이브러리)
CREATE TABLE IF NOT EXISTS seedance_characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text,
  description text,
  image_url text NOT NULL,         -- Supabase Storage public URL
  use_count int NOT NULL DEFAULT 0,
  meta jsonb,                      -- 사이즈, 출처 등
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_seedance_characters_user
  ON seedance_characters(created_by, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE seedance_characters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner all" ON seedance_characters;
CREATE POLICY "owner all" ON seedance_characters
  FOR ALL TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "admin select" ON seedance_characters;
CREATE POLICY "admin select" ON seedance_characters
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
