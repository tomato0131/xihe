begin;

alter table public.profiles
  add column if not exists role text not null default 'user'
  check (role in ('user', 'admin', 'super_admin'));

alter table auth.local_credentials
  add column if not exists username text unique
  check (username is null or username ~ '^[a-zA-Z][a-zA-Z0-9_]{2,31}$');

commit;
