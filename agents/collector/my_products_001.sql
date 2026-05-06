-- =============================================
-- my_products schema (2026-04-29)
-- 사용자별 상품/서비스 카탈로그 — ScriptGen에서 불러쓰기
-- =============================================

BEGIN;

CREATE TABLE IF NOT EXISTS my_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  persona TEXT,
  usps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_my_products_owner ON my_products(owner_id);

ALTER TABLE my_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own products" ON my_products
  FOR SELECT USING (owner_id = auth.uid());

CREATE POLICY "users manage own products" ON my_products
  FOR ALL USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "admins see all products" ON my_products
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER my_products_touch_updated
  BEFORE UPDATE ON my_products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMIT;
