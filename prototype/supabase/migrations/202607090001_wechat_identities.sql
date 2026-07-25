begin;

create table if not exists auth.wechat_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  appid text not null,
  openid text not null,
  unionid text,
  session_key_hash text,
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appid, openid)
);

revoke all on auth.wechat_identities from public, anon, authenticated;

commit;

