-- 그룹 단위 공유 (owner의 group_name 단위 → 그 그룹의 모든 영상 자동 inherit)
-- 영상 그룹은 seedance_videos.meta->>'group_name' 문자열에 저장됨.
-- 새 영상이 그룹에 들어가면 별도 작업 없이 공유 inherit (영상 조회 시점에 group_name 매칭).

CREATE TABLE IF NOT EXISTS seedance_group_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  group_name text NOT NULL,
  shared_with_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  permission text NOT NULL DEFAULT 'view',  -- 'view' | 'edit'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, group_name, shared_with_id)
);

CREATE INDEX IF NOT EXISTS idx_seedance_group_shares_with
  ON seedance_group_shares(shared_with_id);
CREATE INDEX IF NOT EXISTS idx_seedance_group_shares_owner_group
  ON seedance_group_shares(owner_id, group_name);

ALTER TABLE seedance_group_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_shares owner select" ON seedance_group_shares;
CREATE POLICY "group_shares owner select" ON seedance_group_shares
  FOR SELECT TO authenticated USING (
    owner_id = auth.uid() OR shared_with_id = auth.uid()
  );
