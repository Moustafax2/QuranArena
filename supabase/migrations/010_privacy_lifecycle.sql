begin;

-- All multiplayer reads now pass through the application server's membership
-- checks. Removing public grants also disables public postgres-change reads.
revoke all on public.rooms, public.room_players, public.games, public.game_rounds,
  public.round_answers from public, anon, authenticated;
grant all on public.rooms, public.room_players, public.games, public.game_rounds,
  public.round_answers to service_role;
revoke select (id, display_name, avatar_url, total_points, total_wins, created_at)
  on public.players from public, anon, authenticated;

alter table public.players add column last_active_at timestamptz not null default now();
create index players_guest_expiry on public.players(last_active_at) where quran_foundation_uid is null;

-- Minimal erasure evidence, no email, activity, or Quran content. Export this
-- restricted ledger separately before restoring an older database backup.
create table public.privacy_erasure_ledger (
  player_id uuid primary key,
  deleted_at timestamptz not null default now()
);
create table public.privacy_deletion_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);
alter table public.privacy_erasure_ledger enable row level security;
alter table public.privacy_deletion_events enable row level security;
revoke all on public.privacy_erasure_ledger, public.privacy_deletion_events from public, anon, authenticated;
grant all on public.privacy_erasure_ledger, public.privacy_deletion_events to service_role;

alter function public.delete_player_data(uuid) rename to delete_player_data_core;
create function public.delete_player_data(target_player uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.players where id=target_player for update;
  if not found then return; end if;
  insert into public.privacy_erasure_ledger(player_id) values(target_player)
    on conflict(player_id) do nothing;
  perform public.delete_player_data_core(target_player);
end;
$$;

-- Transport-independent adapter. Only a trusted server/operator may invoke it
-- AFTER authenticating a provider event. Event ID is recorded atomically with
-- deletion: failed transactions are retryable; deliveries are idempotent.
create function public.purge_qf_user_data(subject_id text, delivery_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid;
begin
  if subject_id is null or delivery_id is null or length(trim(subject_id))=0 or length(trim(delivery_id))=0 or length(subject_id)>512 or length(delivery_id)>512 then
    raise exception 'Invalid deletion identifiers';
  end if;
  insert into public.privacy_deletion_events(event_id) values(delivery_id) on conflict do nothing;
  if not found then return; end if;
  for target in select id from public.players where quran_foundation_uid=subject_id for update loop
    perform public.delete_player_data(target);
  end loop;
end;
$$;

create function public.withdraw_player_consent(target_player uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.players where id=target_player for update;
  update public.privacy_consents set withdrawn_at=now() where player_id=target_player and withdrawn_at is null;
end;
$$;

-- A single row lock coordinates last activity with cleanup to avoid deleting
-- a guest that has just resumed. Expired guests cannot be revived by touching.
create function public.touch_guest_player(target_player uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.players set last_active_at=now()
    where id=target_player and quran_foundation_uid is null and last_active_at>now()-interval '24 hours';
  return found;
end;
$$;

create function public.cleanup_privacy_data()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; removed integer:=0;
begin
  for target in select id from public.players where quran_foundation_uid is null
    and last_active_at<=now()-interval '24 hours' for update skip locked loop
    perform public.delete_player_data(target); removed:=removed+1;
  end loop;
  -- Unlinked browser receipts expire with their maximum one-year cookie age.
  delete from public.privacy_consents where player_id is null and accepted_at<now()-interval '1 year';
  delete from public.privacy_consents where withdrawn_at<now()-interval '30 days';
  delete from public.privacy_erasure_ledger where deleted_at<now()-interval '90 days';
  delete from public.privacy_deletion_events where processed_at<now()-interval '90 days';
  return removed;
end;
$$;

revoke all on function public.delete_player_data_core(uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_player_data(uuid), public.purge_qf_user_data(text,text),
  public.withdraw_player_consent(uuid), public.touch_guest_player(uuid), public.cleanup_privacy_data() from public, anon, authenticated;
grant execute on function public.delete_player_data(uuid), public.purge_qf_user_data(text,text),
  public.withdraw_player_consent(uuid), public.touch_guest_player(uuid), public.cleanup_privacy_data() to service_role;
-- Reapply an externally preserved ledger BEFORE exposing a restored database.
-- UUIDs target erased player rows only; newly registered accounts have new IDs.
create function public.reapply_privacy_erasures(entries jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare entry jsonb; removed integer:=0; target uuid; erased_at timestamptz;
begin
  if entries is null or jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)>10000 then raise exception 'Invalid ledger'; end if;
  for entry in select value from jsonb_array_elements(entries) loop
    target:=(entry->>'player_id')::uuid;
    erased_at:=(entry->>'deleted_at')::timestamptz;
    if target is null or erased_at is null or erased_at>now() then raise exception 'Invalid ledger entry'; end if;
    perform public.delete_player_data(target);
    insert into public.privacy_erasure_ledger(player_id,deleted_at) values(target,erased_at)
      on conflict(player_id) do update set deleted_at=least(privacy_erasure_ledger.deleted_at, excluded.deleted_at);
    removed:=removed+1;
  end loop;
  -- Old restored sessions and consent receipts must not regain authorization.
  update public.players set session_version=session_version+1;
  update public.privacy_consents set withdrawn_at=now() where withdrawn_at is null;
  return removed;
end;
$$;
revoke all on function public.reapply_privacy_erasures(jsonb) from public, anon, authenticated;
grant execute on function public.reapply_privacy_erasures(jsonb) to service_role;
commit;
