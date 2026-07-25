begin;

create extension if not exists pgcrypto;

create type public.calendar_type as enum ('solar', 'lunar');
create type public.notification_status as enum ('pending', 'processing', 'sent', 'failed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'Asia/Shanghai',
  locale text not null default 'zh-CN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  relationship text check (char_length(relationship) <= 50),
  avatar_path text,
  notes text check (char_length(notes) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.birthdays (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique references public.people(id) on delete cascade,
  calendar_type public.calendar_type not null default 'solar',
  birth_year smallint check (birth_year is null or birth_year between 1900 and 2200),
  birth_month smallint not null check (birth_month between 1 and 12),
  birth_day smallint not null check (birth_day between 1 and 31),
  is_leap_month boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  color text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.person_groups (
  person_id uuid not null references public.people(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  primary key (person_id, group_id)
);

create table public.reminder_rules (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  days_before smallint not null default 3 check (days_before between 0 and 365),
  send_time time not null default '09:00',
  channels text[] not null default array['in_app']::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (person_id, days_before, send_time)
);

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  scheduled_at timestamptz not null,
  channel text not null,
  status public.notification_status not null default 'pending',
  attempts smallint not null default 0,
  dedupe_key text not null unique,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.care_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  action_type text not null check (action_type in ('blessing', 'contact', 'gift', 'completed')),
  content text check (char_length(content) <= 2000),
  completed_at timestamptz not null default now()
);

create index people_user_id_idx on public.people(user_id);
create index groups_user_id_idx on public.groups(user_id);
create index jobs_due_idx on public.notification_jobs(status, scheduled_at);
create index care_records_person_idx on public.care_records(person_id, completed_at desc);

alter table public.profiles enable row level security;
alter table public.people enable row level security;
alter table public.birthdays enable row level security;
alter table public.groups enable row level security;
alter table public.person_groups enable row level security;
alter table public.reminder_rules enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.care_records enable row level security;

create policy profiles_owner_all on public.profiles for all to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy people_owner_all on public.people for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy groups_owner_all on public.groups for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy jobs_owner_select on public.notification_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy jobs_owner_insert on public.notification_jobs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy jobs_owner_update on public.notification_jobs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy care_owner_all on public.care_records for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy birthdays_via_person on public.birthdays for all to authenticated
  using (exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid())));
create policy person_groups_via_person on public.person_groups for all to authenticated
  using (exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid())))
  with check (
    exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid()))
    and exists (select 1 from public.groups g where g.id = group_id and g.user_id = (select auth.uid()))
  );
create policy reminders_via_person on public.reminder_rules for all to authenticated
  using (exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.people p where p.id = person_id and p.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

commit;
