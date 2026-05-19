-- seedance_characters: 1명당 사진 여러 장 (각도/표정별)
-- image_url 은 primary/cover (호환 유지) + image_urls 가 전체 리스트 (primary = image_urls[1])

ALTER TABLE seedance_characters
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT ARRAY[]::text[];

-- 백필: image_urls 비어있고 image_url 있으면 단일-요소 배열로 초기화
UPDATE seedance_characters
SET image_urls = ARRAY[image_url]
WHERE (image_urls IS NULL OR cardinality(image_urls) = 0)
  AND image_url IS NOT NULL;
