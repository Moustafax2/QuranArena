begin;

alter table public.players add column if not exists session_version integer not null default 0;

create table public.privacy_consents (
  id uuid primary key,
  player_id uuid references public.players(id) on delete cascade,
  version text not null,
  accepted_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
alter table public.privacy_consents enable row level security;
revoke all on public.privacy_consents from public, anon, authenticated;
grant all on public.privacy_consents to service_role;

-- Browsers need only public player fields for game rosters. Table-wide SELECT
-- would otherwise expose QF email, identity and login metadata through REST.
revoke select on public.players from public, anon, authenticated;
grant select (id, display_name, avatar_url, total_points, total_wins, created_at)
  on public.players to anon, authenticated;

-- Repair the legacy email-as-name fallback; preserve unrelated chosen names.
update public.players set display_name = 'Player'
where qf_email is not null and lower(trim(display_name)) = lower(trim(qf_email));

create or replace function public.invalidate_player_sessions(target_player uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.players set session_version = session_version + 1 where id = target_player;
$$;

create or replace function public.export_player_data(target_player uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'player', (select to_jsonb(p) - 'session_version' from public.players p where id = target_player),
    'flashcards', coalesce((select jsonb_agg(to_jsonb(t)) from public.user_flashcards t where user_id = target_player), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(to_jsonb(t)) from public.review_log t where user_id = target_player), '[]'::jsonb),
    'preferences', (select to_jsonb(t) from public.user_preferences t where user_id = target_player),
    'memorization', coalesce((select jsonb_agg(to_jsonb(t)) from public.memorization_attempts t where player_id = target_player), '[]'::jsonb),
    'answers', coalesce((select jsonb_agg(to_jsonb(t)) from public.round_answers t where player_id = target_player), '[]'::jsonb),
    'mistakes', coalesce((select jsonb_agg(to_jsonb(t)) from public.verse_mistakes t where player_id = target_player), '[]'::jsonb),
    'room_memberships', coalesce((select jsonb_agg(to_jsonb(t)) from public.room_players t where player_id = target_player), '[]'::jsonb),
    'hosted_rooms', coalesce((select jsonb_agg(to_jsonb(t)) from public.rooms t where host_id = target_player), '[]'::jsonb),
    'friends', coalesce((select jsonb_agg(to_jsonb(t)) from public.friends t where player_a = target_player or player_b = target_player), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(to_jsonb(t)) from public.game_invitations t
      where inviter_player_id = target_player or invitee_qf_user_id = (select quran_foundation_uid from public.players where id = target_player)), '[]'::jsonb),
    'consent', coalesce((select jsonb_agg(to_jsonb(t)) from public.privacy_consents t where player_id = target_player), '[]'::jsonb)
  );
$$;

-- One transaction: either all app records are removed or none are. Retain
-- other players' shared game history by transferring room ownership.
create or replace function public.delete_player_data(target_player uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  qf_subject text;
  owned_room record;
  next_host uuid;
begin
  select quran_foundation_uid into qf_subject from public.players where id = target_player for update;
  if not found then return; end if;
  for owned_room in select id from public.rooms where host_id = target_player for update loop
    select player_id into next_host from public.room_players
      where room_id = owned_room.id and player_id <> target_player order by joined_at limit 1;
    if next_host is not null then
      update public.rooms set host_id = next_host where id = owned_room.id;
    else
      delete from public.games where room_id = owned_room.id;
      delete from public.rooms where id = owned_room.id;
    end if;
  end loop;
  update public.games set winner_id = null where winner_id = target_player;
  delete from public.round_answers where player_id = target_player;
  delete from public.room_players where player_id = target_player;
  delete from public.friends where player_a = target_player or player_b = target_player or requested_by = target_player;
  delete from public.verse_mistakes where player_id = target_player;
  delete from public.game_invitations where inviter_player_id = target_player or invitee_qf_user_id = qf_subject;
  -- Cascades erase reviews, flashcards, preferences, memorization and consent.
  delete from public.players where id = target_player;
end;
$$;

revoke all on function public.invalidate_player_sessions(uuid) from public, anon, authenticated;
revoke all on function public.export_player_data(uuid) from public, anon, authenticated;
revoke all on function public.delete_player_data(uuid) from public, anon, authenticated;
grant execute on function public.invalidate_player_sessions(uuid) to service_role;
grant execute on function public.export_player_data(uuid) to service_role;
grant execute on function public.delete_player_data(uuid) to service_role;
commit;
