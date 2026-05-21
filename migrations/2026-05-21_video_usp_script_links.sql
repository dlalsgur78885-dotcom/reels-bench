-- 영상 ↔ USP 연결 + 대본 ↔ 영상 선택(영상 기획안)
--
-- USP는 my_products.usps[] JSONB 배열의 1-based index(usp_index)로 식별.
-- 영상 1개는 여러 USP에 연결 가능. USP 그룹 선택은 멤버 USP 일괄 링크(UI 단축키)일 뿐
-- 저장은 항상 개별 usp_index 링크로.
-- 대본에 선택된 영상 = 그 대본의 "영상 기획안".

-- 1) 영상 ↔ USP 링크
CREATE TABLE IF NOT EXISTS seedance_video_usp_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES seedance_videos(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES my_products(id) ON DELETE CASCADE,
  usp_index int NOT NULL,  -- 1-based index into my_products.usps[]
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE(video_id, product_id, usp_index)
);
CREATE INDEX IF NOT EXISTS idx_video_usp_links_video ON seedance_video_usp_links(video_id);
CREATE INDEX IF NOT EXISTS idx_video_usp_links_product_usp
  ON seedance_video_usp_links(product_id, usp_index);

ALTER TABLE seedance_video_usp_links ENABLE ROW LEVEL SECURITY;

-- 2) 대본 ↔ 영상 선택 (영상 기획안)
CREATE TABLE IF NOT EXISTS script_video_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES generated_scripts(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES seedance_videos(id) ON DELETE CASCADE,
  order_idx int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE(script_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_script_video_sel_script ON script_video_selections(script_id);

ALTER TABLE script_video_selections ENABLE ROW LEVEL SECURITY;
