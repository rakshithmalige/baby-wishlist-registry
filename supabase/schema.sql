-- One row holds the whole registry. `rev` changes on every save and is used
-- as a compare-and-swap check, so two servers cannot overwrite each other.
create table if not exists public.registry (
  id   int primary key,
  data jsonb not null,
  rev  int not null default 1
);

-- Row Level Security on, with no policies: the publishable key cannot read or
-- write. Only the secret (service) key used by the server can.
alter table public.registry enable row level security;
