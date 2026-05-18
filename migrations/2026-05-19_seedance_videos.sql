-- Seedance 2.0 으로 생성한 영상 라이브러리 — 사용자별 보관
-- 실행: Supabase SQL Editor에 붙여넣기

CREATE TABLE IF NOT EXISTS seedance_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  name text,                       -- 사용자 지정 이름 (선택)
  prompt text,                     -- 생성 시 사용한 프롬프트
  video_url text NOT NULL,         -- Supabase Storage 공개 URL (fal CDN은 만료 가능 → 우리 인프라로 옮김)
  thumbnail_url text,              -- 미리보기 (선택)
  source_blog_url text,            -- 블로그에서 추출한 경우 원본 URL
  start_image_url text,            -- fal storage URL (시작 프레임)
  end_image_url text,              -- fal storage URL (끝 프레임, 선택)

  resolution text,                 -- '480p' / '720p' / '1080p'
  duration text,                   -- '4' ~ '15' or 'auto'
  aspect_ratio text,               -- '9:16' / '16:9' / ...
  generate_audio boolean,
  seed bigint,

  meta jsonb,                      -- 기타 (request_id, file_size 등)
  archived_at timestamptz          -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_seedance_videos_user_created
  ON seedance_videos(created_by, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE seedance_videos ENABLE ROW LEVEL SECURITY;

-- service_role 은 모두 통과, 사용자 본인 row 만 SELECT/UPDATE/DELETE
DROP POLICY IF EXISTS "owner select" ON seedance_videos;
CREATE POLICY "owner select" ON seedance_videos
  FOR SELECT TO authenticated USING (created_by = auth.uid());

DROP POLICY IF EXISTS "owner insert" ON seedance_videos;
CREATE POLICY "owner insert" ON seedance_videos
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "owner update" ON seedance_videos;
CREATE POLICY "owner update" ON seedance_videos
  FOR UPDATE TO authenticated USING (created_by = auth.uid());

DROP POLICY IF EXISTS "owner delete" ON seedance_videos;
CREATE POLICY "owner delete" ON seedance_videos
  FOR DELETE TO authenticated USING (created_by = auth.uid());

-- admin은 전체 SELECT 가능
DROP POLICY IF EXISTS "admin select all" ON seedance_videos;
CREATE POLICY "admin select all" ON seedance_videos
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
