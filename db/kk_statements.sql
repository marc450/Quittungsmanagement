-- Credit card statements ("Kreditkartenabrechnungen") for the self-service
-- reconciliation feature (KK-Abrechnung tab). One row per uploaded statement;
-- the parsed transactions live in the `transactions` jsonb, each carrying the
-- assigned receipt as `beleg_id` (null when unassigned). Accessed directly from
-- the browser via supabase-js, so RLS restricts every row to its owner.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.kk_statements (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'Kreditkartenabrechnung',
  transactions jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists kk_statements_user_created_idx
  on public.kk_statements (user_id, created_at desc);

alter table public.kk_statements enable row level security;

-- Each user manages only their own statements.
create policy "kk_statements_select_own" on public.kk_statements
  for select using (auth.uid() = user_id);

create policy "kk_statements_insert_own" on public.kk_statements
  for insert with check (auth.uid() = user_id);

create policy "kk_statements_update_own" on public.kk_statements
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kk_statements_delete_own" on public.kk_statements
  for delete using (auth.uid() = user_id);
