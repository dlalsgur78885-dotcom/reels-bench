-- 인물 그룹 — 영상 배우 일관성을 위한 그룹 축.
-- USP 그룹 / 자유 텍스트 그룹과 별개인 3번째 그룹 라인 (전역).
-- 각 인물 그룹은 인물(seedance_characters) 1명을 가짐. 영상은 meta.character_group_id로 단일 연결.
-- 라벨/분류 용도 — 영상 생성 파이프라인은 건드리지 않음.

CREATE TABLE IF NOT EXISTS seedance_character_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  character_id uuid REFERENCES seedance_characters(id) ON DELETE SET NULL,
  created_by uuid REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seedance_char_groups_creator
  ON seedance_character_groups(created_by);

ALTER TABLE seedance_character_groups ENABLE ROW LEVEL SECURITY;
