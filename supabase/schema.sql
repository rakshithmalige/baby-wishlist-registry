-- Run once in the Supabase SQL editor (or with apply_migration).
--
-- Access works like this. The public anon key lets a request reach the table.
-- Row-level security then checks an `x-registry-key` header against a stored
-- SHA-256 hash. Without the right key the table reads as empty and writes are
-- refused. Only the hash is in the database; the key itself lives in Vercel.

-- 1. The registry: one row (id = 1), `rev` is the save check.
create table if not exists public.registry (
  id   int primary key,
  data jsonb not null,
  rev  int not null default 1
);
alter table public.registry enable row level security;

-- 2. The stored hash of the registry key.
--    Replace the placeholder with the output of:  printf '%s' "$REGISTRY_SECRET" | sha256sum
create table if not exists public.registry_access (
  id       int primary key,
  key_hash text not null
);
alter table public.registry_access enable row level security;
insert into public.registry_access (id, key_hash)
values (1, '<sha256 hex of REGISTRY_SECRET>')
on conflict (id) do update set key_hash = excluded.key_hash;

-- 3. True only when the x-registry-key header hashes to the stored value.
--    SECURITY DEFINER lets the check read registry_access, which anon cannot.
create or replace function public.registry_key_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(coalesce(current_setting('request.headers', true)::json->>'x-registry-key', ''), 'sha256'), 'hex')
         = (select key_hash from public.registry_access where id = 1)
$$;

-- 4. Only requests carrying the right key may read or write the registry.
drop policy if exists registry_server_only on public.registry;
create policy registry_server_only on public.registry
  for all to anon
  using (public.registry_key_ok())
  with check (public.registry_key_ok());
