begin;

create policy jobs_owner_insert on public.notification_jobs for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy jobs_owner_update on public.notification_jobs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
