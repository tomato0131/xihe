create table if not exists auth.local_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  username text unique,
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

revoke all on auth.local_credentials from public, anon, authenticated;
