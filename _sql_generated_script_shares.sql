-- 저장된 대본 공유 테이블
create table if not exists generated_script_shares (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references generated_scripts(id) on delete cascade,
  shared_with_id uuid not null references profiles(id) on delete cascade,
  shared_by uuid not null references profiles(id),
  permission text not null check (permission in ('view', 'edit')) default 'view',
  created_at timestamptz default now(),
  unique (script_id, shared_with_id)
);

create index if not exists idx_script_shares_with on generated_script_shares(shared_with_id);
create index if not exists idx_script_shares_script on generated_script_shares(script_id);

alter table generated_script_shares enable row level security;
create policy "Service role bypass" on generated_script_shares for all using (true) with check (true);
