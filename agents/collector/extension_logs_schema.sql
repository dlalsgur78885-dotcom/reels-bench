-- Chrome Extension 원격 디버깅용 로그 테이블
-- Supabase Dashboard → SQL Editor 에서 한 번 실행하면 됨

CREATE TABLE IF NOT EXISTS extension_logs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id  TEXT NOT NULL,
  version     TEXT,
  level       TEXT NOT NULL,           -- 'info' | 'warn' | 'error'
  event       TEXT NOT NULL,           -- 'collect_start' | 'extract_done' | ...
  message     TEXT,
  context     JSONB,                   -- url, count, dom_sample, error stack 등
  user_agent  TEXT,
  page_url    TEXT
);

CREATE INDEX IF NOT EXISTS idx_extension_logs_ts          ON extension_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_extension_logs_session     ON extension_logs(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_extension_logs_level_event ON extension_logs(level, event);

-- RLS — 익스텐션은 anon 키만 가지고 있으니 INSERT 허용 필요
ALTER TABLE extension_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON extension_logs FOR ALL USING (true) WITH CHECK (true);

-- 1주일 이상 된 로그 자동 삭제 (Supabase pg_cron 쓸 수 있으면)
-- SELECT cron.schedule('purge_extension_logs', '0 3 * * *',
--   $$DELETE FROM extension_logs WHERE ts < now() - interval '7 days'$$);
