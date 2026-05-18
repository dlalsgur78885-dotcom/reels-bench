-- 대본 생성 완료 이벤트 로그 (저장과 별개로 모든 성공 generation 기록)
-- 실행: Supabase SQL Editor에 붙여넣기

CREATE TABLE IF NOT EXISTS script_gen_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  product_name text,
  reference_shortcodes text[],
  reference_source text,                -- 'reels' or 'youtube'
  persona_name text,
  success boolean NOT NULL DEFAULT true,
  cost_usd numeric,
  sentence_count int,
  duration_target_sec int,
  error_msg text
);

CREATE INDEX IF NOT EXISTS idx_gen_events_user_created
  ON script_gen_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_events_created
  ON script_gen_events(created_at DESC);

-- RLS (service_role bypass, 다른 role은 admin만 SELECT 허용)
ALTER TABLE script_gen_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin select all" ON script_gen_events;
CREATE POLICY "admin select all" ON script_gen_events
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
