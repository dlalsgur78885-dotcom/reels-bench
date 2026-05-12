-- 생성된 대본 저장 테이블
-- Supabase SQL Editor에서 실행

create table if not exists generated_scripts (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references my_products(id) on delete cascade,
  ref_shortcode text,                   -- 참고 ref (insta shortcode / yt video_id / fb ad_id)
  source_type text check (source_type in ('insta', 'youtube', 'fb_ads')),
  persona_name text,                    -- 어느 페르소나로 생성됐는지
  title text,                            -- 사용자가 붙인 제목 (선택)
  sentences jsonb,                       -- 생성된 sentences[]
  meta jsonb,                            -- duration / refined / cost / target_persona 등
  created_at timestamptz default now(),
  created_by uuid references profiles(id),
  archived_at timestamptz                -- soft delete
);

create index if not exists idx_gen_scripts_product_created
  on generated_scripts(product_id, created_at desc)
  where archived_at is null;

-- RLS (선택)
alter table generated_scripts enable row level security;

create policy "Service role bypass" on generated_scripts
  for all using (true) with check (true);
