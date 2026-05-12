-- USP 그룹핑 (USPs JSONB는 안 건드리고 별도 매핑 테이블로 격리)

create table if not exists usp_groups (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references my_products(id) on delete cascade,
  name text not null,
  color text,                              -- 선택 (UI 뱃지 색, hex)
  order_idx int default 0,
  created_at timestamptz default now(),
  created_by uuid references profiles(id)
);

create index if not exists idx_usp_groups_product on usp_groups(product_id, order_idx);

create table if not exists usp_group_members (
  group_id uuid not null references usp_groups(id) on delete cascade,
  product_id bigint not null references my_products(id) on delete cascade,
  usp_index int not null,                  -- my_products.usps[] 안의 위치 (1-based)
  created_at timestamptz default now(),
  primary key (group_id, usp_index)
);

create index if not exists idx_usp_group_members_product on usp_group_members(product_id);
create index if not exists idx_usp_group_members_group on usp_group_members(group_id);

alter table usp_groups enable row level security;
alter table usp_group_members enable row level security;

create policy "Service role bypass groups" on usp_groups for all using (true) with check (true);
create policy "Service role bypass members" on usp_group_members for all using (true) with check (true);
