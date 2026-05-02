-- =============================================
-- my_product_shares (2026-05-03)
-- 상품 공유 테이블 — 기본 view, 옵션 edit
-- =============================================

BEGIN;

CREATE TABLE IF NOT EXISTS my_product_shares (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES my_products(id) ON DELETE CASCADE,
  shared_with_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'view'
    CHECK (permission IN ('view', 'edit')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, shared_with_id)
);

CREATE INDEX IF NOT EXISTS idx_mps_shared_with ON my_product_shares(shared_with_id);
CREATE INDEX IF NOT EXISTS idx_mps_product ON my_product_shares(product_id);

ALTER TABLE my_product_shares ENABLE ROW LEVEL SECURITY;

-- 조회: 받은 사람 OR 상품 소유자
CREATE POLICY "shares visible to owner or recipient" ON my_product_shares
  FOR SELECT USING (
    shared_with_id = auth.uid()
    OR EXISTS (SELECT 1 FROM my_products p WHERE p.id = product_id AND p.owner_id = auth.uid())
  );

-- 생성/수정/삭제: 상품 소유자만
CREATE POLICY "owners manage their shares" ON my_product_shares
  FOR ALL USING (
    EXISTS (SELECT 1 FROM my_products p WHERE p.id = product_id AND p.owner_id = auth.uid())
  );

COMMIT;
