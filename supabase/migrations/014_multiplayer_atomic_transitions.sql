-- ============================================
-- Atomic multiplayer state transitions (reduced form)
-- ============================================
-- This is a REDUCED form of migration 014 on the `fix/audit-remediation`
-- branch (commit d21283a). It keeps only what audit findings H1, M3 and H5
-- need. Removed from that version, on purpose:
--   * L6 (no win without a positive score; a tie gives every tied player a
--     win). mp_finish_game keeps the existing rule: one winner, the top scorer
--     (earliest to join on a tie), even on 0 points.
--   * L19 (a player who left a lobby may rejoin it). mp_join_room keeps the
--     existing refusal ("left_room").
--   * M2's 50-round cap on mp_start_game (the 'invalid_rounds' status now
--     only refuses a start with no rounds, which the edge function already
--     refuses).
--   * Reply changes: an active member re-joining a full room is refused, as
--     before (the capacity check comes first), and mp_finish_game returns no
--     `winner_ids` list.
--
-- Before this migration the edge functions ran each transition as a series of
-- separate PostgREST calls (read, then write), so two callers could both pass
-- a check before either wrote. Each transition is now one SQL function, which
-- runs in one transaction:
--
--   * mp_end_round / mp_finish_game claim the round or game first, with a
--     conditional update (`... where ended_at is null`). Postgres lets only
--     one caller's update match; the others get no row and stop, so points
--     and lifetime stats are added exactly once (H1).
--   * mp_submit_answer locks the round row, so the speed-bonus count, the
--     buzzer check and the answer insert see every earlier answer, and the
--     verse mistake count is an `on conflict ... do update` increment (M3).
--     It rejects answers to rounds that have not started or have ended (H1)
--     and answers more than 2 s past the round's deadline (H5).
--   * mp_advance_round ends the open round when every live player has
--     answered OR its time_per_question has run out (H5), through the same
--     claim as above.
--   * mp_start_game and mp_join_room lock the room row, so there is one game
--     per start and never more than 8 active players (M3).
--
-- The app reaches these through the service role only (edge functions with an
-- admin client), so execute is granted to service_role alone. Append-only:
-- earlier migrations are unchanged. No table or column is added.

begin;

-- Seconds a question runs (H5). Mirrors effectiveTimePerQuestion() in
-- supabase/functions/_shared/room-settings.ts (bounds 10-120, default 30), so
-- the countdown the app shows matches the deadline enforced here. Rooms may
-- hold any stored value; it is clamped.
create function public.mp_time_per_question(settings jsonb)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case
    when jsonb_typeof(settings -> 'time_per_question') = 'number'
      then round(least(greatest((settings ->> 'time_per_question')::numeric, 10), 120))::integer
    else 30
  end;
$$;

-- Ends a game exactly once. p_award = false ends it without a winner or
-- lifetime stats (used when no live player is left, as before).
create function public.mp_finish_game(p_game_id uuid, p_award boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room uuid;
  v_winner uuid;
begin
  -- The claim: only the caller whose update matches goes on (audit H1).
  update public.games set ended_at = clock_timestamp()
    where id = p_game_id and ended_at is null
    returning room_id into v_room;
  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  if p_award then
    -- The existing win rule: the top scorer among the players still in the
    -- room wins, whatever the score.
    select player_id into v_winner from public.room_players
      where room_id = v_room and status = 'active'
      order by score desc, joined_at
      limit 1;
  end if;

  update public.games set winner_id = v_winner where id = p_game_id;
  update public.rooms set status = 'finished' where id = v_room;

  if p_award then
    update public.players p
      set total_points = p.total_points + rp.score,
          total_wins = p.total_wins + case when rp.player_id = v_winner then 1 else 0 end
      from public.room_players rp
      where rp.room_id = v_room and rp.status = 'active' and p.id = rp.player_id;
  end if;

  return jsonb_build_object('claimed', true, 'winner_id', v_winner);
end;
$$;

-- Ends an open round exactly once, adds its points, then starts the next
-- round or finishes the game.
create function public.mp_end_round(p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_game uuid;
  v_round_number integer;
  v_room uuid;
  v_total integer;
  v_next uuid;
begin
  -- The claim comes first: a second caller gets no row and adds nothing
  -- (audit H1). Rounds of a game that has already ended stay closed.
  update public.game_rounds r set ended_at = clock_timestamp()
    where r.id = p_round_id and r.started_at is not null and r.ended_at is null
      and exists (select 1 from public.games g where g.id = r.game_id and g.ended_at is null)
    returning r.game_id, r.round_number into v_game, v_round_number;
  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  select room_id, total_rounds into v_room, v_total from public.games where id = v_game;

  -- Points of players still in the room, added once with the claim.
  update public.room_players rp set score = rp.score + a.points
    from (
      select player_id, sum(points_awarded)::integer as points
      from public.round_answers
      where round_id = p_round_id and points_awarded > 0
      group by player_id
    ) a
    where rp.room_id = v_room and rp.player_id = a.player_id and rp.status = 'active';

  if v_round_number >= v_total then
    return jsonb_build_object(
      'claimed', true,
      'game_finished', (public.mp_finish_game(v_game) ->> 'claimed')::boolean
    );
  end if;

  update public.game_rounds set started_at = clock_timestamp()
    where game_id = v_game and round_number = v_round_number + 1 and started_at is null
    returning id into v_next;
  if not found then
    raise exception 'Next round not found';
  end if;

  return jsonb_build_object('claimed', true, 'game_finished', false, 'next_round_id', v_next);
end;
$$;

-- Moves a game on after a heartbeat, a departure or an answer: ends the open
-- round once every live player has answered or its time is up (audit H5), and
-- ends the game when no live player is left.
create function public.mp_advance_round(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room uuid;
  v_settings jsonb;
  v_round uuid;
  v_started timestamptz;
  v_live uuid[];
  v_answered integer;
  v_reason text;
begin
  select g.room_id, r.settings into v_room, v_settings
    from public.games g join public.rooms r on r.id = g.room_id
    where g.id = p_game_id and g.ended_at is null;
  if not found then
    return jsonb_build_object('action', 'none');
  end if;

  select id, started_at into v_round, v_started from public.game_rounds
    where game_id = p_game_id and started_at is not null and ended_at is null
    order by round_number
    limit 1;
  if not found then
    return jsonb_build_object('action', 'none');
  end if;

  -- Live players: active and seen in the last 15 seconds (heartbeats every 5).
  select coalesce(array_agg(player_id), '{}') into v_live from public.room_players
    where room_id = v_room and status = 'active'
      and last_seen_at > clock_timestamp() - interval '15 seconds';

  if cardinality(v_live) = 0 then
    perform public.mp_finish_game(p_game_id, false);
    return jsonb_build_object('action', 'game_finished', 'reason', 'no_players');
  end if;

  select count(*) into v_answered from public.round_answers
    where round_id = v_round and player_id = any(v_live);

  if v_answered >= cardinality(v_live) then
    v_reason := 'all_answered';
  elsif clock_timestamp() >= v_started + make_interval(secs => public.mp_time_per_question(v_settings)) then
    v_reason := 'deadline';
  else
    return jsonb_build_object('action', 'none');
  end if;

  return jsonb_build_object('action', 'round_ended', 'reason', v_reason) || public.mp_end_round(v_round);
end;
$$;

-- Records one answer (or buzz) and moves the game on. Returns a status the
-- edge function maps to an HTTP response.
create function public.mp_submit_answer(
  p_game_id uuid,
  p_round_id uuid,
  p_player_id uuid,
  p_answer_verse_key text,
  p_is_buzzer boolean
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
  v_room uuid;
  v_settings jsonb;
  v_game_ended timestamptz;
  v_started timestamptz;
  v_ended timestamptz;
  v_correct_key text;
  v_is_correct boolean;
  v_correct_count integer;
  v_points integer;
  v_advance jsonb;
begin
  select g.room_id, g.ended_at, r.settings into v_room, v_game_ended, v_settings
    from public.games g join public.rooms r on r.id = g.room_id
    where g.id = p_game_id;
  if not found then
    return jsonb_build_object('status', 'game_not_found');
  end if;
  if v_game_ended is not null then
    return jsonb_build_object('status', 'game_ended');
  end if;
  if not exists (
    select 1 from public.room_players
    where room_id = v_room and player_id = p_player_id and status = 'active'
  ) then
    return jsonb_build_object('status', 'not_participant');
  end if;

  -- One answer at a time per round (audit M3). Taken before any room_players
  -- write, the same order mp_end_round uses, so the two cannot deadlock.
  select started_at, ended_at, correct_verse_key into v_started, v_ended, v_correct_key
    from public.game_rounds
    where id = p_round_id and game_id = p_game_id
    for update;
  if not found then
    return jsonb_build_object('status', 'round_not_found');
  end if;

  update public.room_players set last_seen_at = v_now
    where room_id = v_room and player_id = p_player_id and status = 'active';

  -- Audit H1: only the open round takes answers.
  if v_started is null or v_ended is not null then
    return jsonb_build_object('status', 'round_not_open');
  end if;
  if exists (select 1 from public.round_answers where round_id = p_round_id and player_id = p_player_id) then
    return jsonb_build_object('status', 'already_answered');
  end if;
  -- Audit H5: two seconds of grace for answers already on their way.
  if v_now > v_started + make_interval(secs => public.mp_time_per_question(v_settings) + 2) then
    return jsonb_build_object('status', 'time_up');
  end if;

  if coalesce(p_is_buzzer, false) then
    if exists (select 1 from public.round_answers where round_id = p_round_id) then
      return jsonb_build_object('status', 'buzzer_taken');
    end if;
    insert into public.round_answers (round_id, player_id, is_correct, server_received_at, points_awarded)
      values (p_round_id, p_player_id, false, v_now, 0);
    return jsonb_build_object('status', 'buzzer_winner');
  end if;

  v_is_correct := coalesce(p_answer_verse_key = v_correct_key, false);
  -- Speed bonus: 3, 2, 1 for the first three correct answers, then none.
  select count(*) into v_correct_count from public.round_answers
    where round_id = p_round_id and is_correct;
  v_points := case
    when v_is_correct then 5 + coalesce((array[3, 2, 1])[v_correct_count + 1], 0)
    else 0
  end;

  insert into public.round_answers (round_id, player_id, answer_verse_key, is_correct, server_received_at, points_awarded)
    values (p_round_id, p_player_id, p_answer_verse_key, v_is_correct, v_now, v_points);

  if not v_is_correct then
    insert into public.verse_mistakes (player_id, verse_key, mistake_count, last_mistake_at)
      values (p_player_id, v_correct_key, 1, v_now)
      on conflict (player_id, verse_key) do update
        set mistake_count = public.verse_mistakes.mistake_count + 1,
            last_mistake_at = excluded.last_mistake_at;
  end if;

  v_advance := public.mp_advance_round(p_game_id);

  return jsonb_build_object(
    'status', 'ok',
    'is_correct', v_is_correct,
    'points_awarded', v_points,
    'round_ended', v_advance ->> 'action' = 'round_ended'
  );
end;
$$;

-- Starts a game from pre-generated rounds. p_rounds is a JSON array of round
-- objects (prompt_verse_key, correct_verse_key, prompt_text, correct_text,
-- options, game_mode, prompt_surah_id, prompt_juz_number, prompt_page_number).
-- Any failure rolls back the whole start, so no orphan game is left (M3).
create function public.mp_start_game(p_room_id uuid, p_player_id uuid, p_rounds jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_host uuid;
  v_status text;
  v_count integer;
  v_game uuid;
  v_first uuid;
begin
  -- A game needs a first round to start (the edge function already refuses
  -- an empty list; no upper limit here).
  if jsonb_typeof(p_rounds) is distinct from 'array' or jsonb_array_length(p_rounds) < 1 then
    return jsonb_build_object('status', 'invalid_rounds');
  end if;

  -- One start per room: a second start waits here, then sees that the room
  -- has left the lobby (audit M3).
  select host_id, status into v_host, v_status from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('status', 'room_not_found');
  end if;
  if v_host is distinct from p_player_id then
    return jsonb_build_object('status', 'not_host');
  end if;
  if v_status <> 'lobby' then
    return jsonb_build_object('status', 'already_started');
  end if;
  if not exists (select 1 from public.room_players where room_id = p_room_id and status = 'active') then
    return jsonb_build_object('status', 'no_players');
  end if;

  v_count := jsonb_array_length(p_rounds);
  insert into public.games (room_id, total_rounds) values (p_room_id, v_count) returning id into v_game;

  insert into public.game_rounds (
    game_id, round_number, game_mode, prompt_verse_key, prompt_surah_id, prompt_juz_number,
    prompt_page_number, correct_verse_key, prompt_text, correct_text, options
  )
  select v_game, q.ord, q.value ->> 'game_mode', q.value ->> 'prompt_verse_key',
    (q.value ->> 'prompt_surah_id')::integer, (q.value ->> 'prompt_juz_number')::integer,
    (q.value ->> 'prompt_page_number')::integer, q.value ->> 'correct_verse_key',
    q.value ->> 'prompt_text', q.value ->> 'correct_text',
    case when jsonb_typeof(q.value -> 'options') = 'array' then q.value -> 'options' end
  from jsonb_array_elements(p_rounds) with ordinality as q(value, ord);

  update public.game_rounds set started_at = clock_timestamp()
    where game_id = v_game and round_number = 1
    returning id into v_first;
  update public.rooms set status = 'in_progress' where id = p_room_id;
  update public.room_players set score = 0 where room_id = p_room_id and status = 'active';

  return jsonb_build_object('status', 'ok', 'game_id', v_game, 'total_rounds', v_count, 'first_round_id', v_first);
end;
$$;

-- Adds a player to a lobby, at most 8 active players per room. The checks run
-- in the same order as before: lobby, capacity, then a departed player is
-- refused and an active member is only marked seen.
create function public.mp_join_room(p_room_code text, p_player_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms%rowtype;
  v_membership text;
  v_active integer;
begin
  -- One join at a time per room, so the capacity count and the insert see the
  -- same roster (audit M3).
  select * into v_room from public.rooms where code = upper(p_room_code) for update;
  if not found then
    return jsonb_build_object('status', 'room_not_found');
  end if;
  if v_room.status <> 'lobby' then
    return jsonb_build_object('status', 'not_lobby');
  end if;

  select count(*) into v_active from public.room_players
    where room_id = v_room.id and status = 'active';
  if v_active >= 8 then
    return jsonb_build_object('status', 'room_full');
  end if;

  select status into v_membership from public.room_players
    where room_id = v_room.id and player_id = p_player_id;

  if v_membership = 'left' then
    return jsonb_build_object('status', 'left_room');
  elsif v_membership is null then
    insert into public.room_players (room_id, player_id, status, left_at, last_seen_at)
      values (v_room.id, p_player_id, 'active', null, clock_timestamp());
  else
    update public.room_players set last_seen_at = clock_timestamp()
      where room_id = v_room.id and player_id = p_player_id and status = 'active';
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'room_id', v_room.id,
    'code', v_room.code,
    'host_id', v_room.host_id,
    'game_mode', v_room.game_mode,
    'settings', v_room.settings
  );
end;
$$;

revoke all on function
  public.mp_time_per_question(jsonb),
  public.mp_finish_game(uuid, boolean),
  public.mp_end_round(uuid),
  public.mp_advance_round(uuid),
  public.mp_submit_answer(uuid, uuid, uuid, text, boolean),
  public.mp_start_game(uuid, uuid, jsonb),
  public.mp_join_room(text, uuid)
  from public, anon, authenticated;

-- The edge functions call these four. The others run only inside them (as
-- the function owner).
grant execute on function
  public.mp_advance_round(uuid),
  public.mp_submit_answer(uuid, uuid, uuid, text, boolean),
  public.mp_start_game(uuid, uuid, jsonb),
  public.mp_join_room(text, uuid)
  to service_role;

commit;
