create table if not exists public.jarvis_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.jarvis_profiles enable row level security;

create policy "Users can read their own Jarvis profile"
on public.jarvis_profiles for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own Jarvis profile"
on public.jarvis_profiles for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own Jarvis profile"
on public.jarvis_profiles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on public.jarvis_profiles from anon;
grant select, insert, update on public.jarvis_profiles to authenticated;