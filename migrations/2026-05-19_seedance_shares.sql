-- 영상/프롬프트/인물 공유 테이블 (3종 동일 구조)

-- 영상 공유
CREATE TABLE IF NOT EXISTS seedance_video_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES seedance_videos(id) ON DELETE CASCADE,
  shared_with_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  permission text NOT NULL DEFAULT 'view',  -- 'view' | 'edit'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(video_id, shared_with_id)
);
CREATE INDEX IF NOT EXISTS idx_seedance_video_shares_with ON seedance_video_shares(shared_with_id);
ALTER TABLE seedance_video_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "video_shares owner select" ON seedance_video_shares;
CREATE POLICY "video_shares owner select" ON seedance_video_shares
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM seedance_videos WHERE id = video_id AND created_by = auth.uid())
    OR shared_with_id = auth.uid()
  );

-- 프롬프트 공유
CREATE TABLE IF NOT EXISTS seedance_prompt_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES seedance_prompts(id) ON DELETE CASCADE,
  shared_with_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  permission text NOT NULL DEFAULT 'view',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(prompt_id, shared_with_id)
);
CREATE INDEX IF NOT EXISTS idx_seedance_prompt_shares_with ON seedance_prompt_shares(shared_with_id);
ALTER TABLE seedance_prompt_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prompt_shares owner select" ON seedance_prompt_shares;
CREATE POLICY "prompt_shares owner select" ON seedance_prompt_shares
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM seedance_prompts WHERE id = prompt_id AND created_by = auth.uid())
    OR shared_with_id = auth.uid()
  );

-- 인물 공유
CREATE TABLE IF NOT EXISTS seedance_character_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES seedance_characters(id) ON DELETE CASCADE,
  shared_with_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  permission text NOT NULL DEFAULT 'view',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, shared_with_id)
);
CREATE INDEX IF NOT EXISTS idx_seedance_character_shares_with ON seedance_character_shares(shared_with_id);
ALTER TABLE seedance_character_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "character_shares owner select" ON seedance_character_shares;
CREATE POLICY "character_shares owner select" ON seedance_character_shares
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM seedance_characters WHERE id = character_id AND created_by = auth.uid())
    OR shared_with_id = auth.uid()
  );
