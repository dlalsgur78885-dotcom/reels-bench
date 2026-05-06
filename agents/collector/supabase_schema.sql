-- =============================================
-- Reels Collector - Supabase 테이블 스키마
-- Supabase SQL Editor에서 실행하세요:
-- https://supabase.com/dashboard/project/mrpbovbxtablvawszhey/sql/new
-- =============================================

-- 1. 릴스 데이터 테이블
CREATE TABLE IF NOT EXISTS reels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL CHECK (shortcode ~ '^[A-Za-z0-9_-]{5,22}$'),
  url TEXT NOT NULL,
  views_text TEXT,
  likes_text TEXT,
  stats_text JSONB,
  source TEXT DEFAULT 'reels_tab',
  account_category TEXT,
  video_src TEXT,
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. HikerAPI로 수집한 메타데이터 테이블
CREATE TABLE IF NOT EXISTS reels_metadata (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL REFERENCES reels(shortcode),
  play_count BIGINT,
  like_count BIGINT,
  comment_count BIGINT,
  reshare_count BIGINT,
  video_url TEXT,
  video_duration FLOAT,
  thumbnail_url TEXT,
  music_artist TEXT,
  music_title TEXT,
  caption_text TEXT,
  author_username TEXT,
  author_full_name TEXT,
  author_is_verified BOOLEAN,
  taken_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 대본 테이블
CREATE TABLE IF NOT EXISTS reels_transcripts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL REFERENCES reels(shortcode),
  transcript TEXT,
  language TEXT,
  segments JSONB,
  transcribed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 댓글 테이블
CREATE TABLE IF NOT EXISTS reels_comments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT NOT NULL REFERENCES reels(shortcode),
  comment_text TEXT,
  comment_author TEXT,
  comment_likes INT,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shortcode, comment_author, comment_text)
);

-- 5. 모니터링 채널 테이블
CREATE TABLE IF NOT EXISTS monitored_channels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  reel_count INT DEFAULT 0,
  last_collected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. 카테고리 분류 테이블
CREATE TABLE IF NOT EXISTS reels_category (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL REFERENCES reels(shortcode),
  topic TEXT,
  topic_detail TEXT,
  style TEXT,
  tags JSONB,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 대본 구조 분석 테이블
CREATE TABLE IF NOT EXISTS reels_script_structure (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL REFERENCES reels(shortcode),
  hook JSONB,
  intro JSONB,
  body JSONB,
  cta JSONB,
  overall JSONB,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. 댓글 반응 분석 테이블
CREATE TABLE IF NOT EXISTS reels_comment_analysis (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode TEXT UNIQUE NOT NULL REFERENCES reels(shortcode),
  triggers JSONB,
  summary JSONB,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_reels_collected_at ON reels(collected_at);
CREATE INDEX IF NOT EXISTS idx_reels_account_category ON reels(account_category);
CREATE INDEX IF NOT EXISTS idx_reels_shortcode ON reels(shortcode);
CREATE INDEX IF NOT EXISTS idx_reels_metadata_shortcode ON reels_metadata(shortcode);
CREATE INDEX IF NOT EXISTS idx_reels_comments_shortcode ON reels_comments(shortcode);
CREATE INDEX IF NOT EXISTS idx_reels_category_shortcode ON reels_category(shortcode);
CREATE INDEX IF NOT EXISTS idx_reels_script_structure_shortcode ON reels_script_structure(shortcode);
CREATE INDEX IF NOT EXISTS idx_reels_comment_analysis_shortcode ON reels_comment_analysis(shortcode);

-- RLS (Row Level Security) 활성화 + 공개 접근 허용
ALTER TABLE reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitored_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_script_structure ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels_comment_analysis ENABLE ROW LEVEL SECURITY;

-- anon 키로 읽기/쓰기 허용
CREATE POLICY "Allow all for anon" ON reels FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_metadata FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_transcripts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_comments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON monitored_channels FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_category FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_script_structure FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON reels_comment_analysis FOR ALL USING (true) WITH CHECK (true);
