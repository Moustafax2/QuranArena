// H1 / M3 / H5 (server side): multiplayer races and the round deadline, run
// against the REAL edge functions and the LOCAL Postgres.
//
// LOCAL Supabase stack only. Not part of `npm test`. It needs the edge
// functions served locally:
//   npx supabase functions serve --env-file supabase/functions/.env
// then, from the repo root:
//   node scripts/test-multiplayer-races-local.mjs        (MP_TRIALS=20 for more trials)
//
// It reads the local URL and service key from .env.development.local (the
// *_LOCAL entries) and the server secret from supabase/functions/.env, never
// prints them, and refuses any URL that is not 127.0.0.1 or localhost. Rows are
// written to the local Postgres container through `docker exec ... psql`; every
// row it creates belongs to throwaway players named "mp-race-*" and is deleted
// at the end.
//
// Calls marked "at once" are sent with Promise.all, so they run in parallel on
// the edge runtime and in Postgres as truly concurrent transactions.
//
// Exit 1 while any race or the missing deadline reproduces (before migration
// 014 and the edge-function rewrites), exit 0 after.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "").trim()]),
  );
const fnEnv = readEnv("supabase/functions/.env");
const appEnv = readEnv(".env.development.local");
const BASE = (appEnv.NEXT_PUBLIC_SUPABASE_URL_LOCAL ?? "").replace(/\/$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error("refusing: not a local Supabase URL");
const SRK = appEnv.SUPABASE_SERVICE_ROLE_KEY_LOCAL;
const SECRET = fnEnv.MULTIPLAYER_SERVER_SECRET;
if (!SRK || !SECRET) throw new Error("missing the local service key or the multiplayer server secret");
const TRIALS = Number(process.env.MP_TRIALS ?? 10);

const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
if (!projectId) throw new Error("project_id not found in supabase/config.toml");
const DB_CONTAINER = `supabase_db_${projectId}`;

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
  }).trim();

async function call(fn, body) {
  const res = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "x-quranarena-server-secret": SECRET, apikey: SRK, authorization: `Bearer ${SRK}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const made = { players: [], rooms: [] };
function newPlayers(n) {
  const ids = Array.from({ length: n }, () => randomUUID());
  psql(ids.map((id, i) => `insert into players (id, display_name) values ('${id}', 'mp-race-${i}');`).join("\n"));
  made.players.push(...ids);
  return ids;
}
function newRoom(host, members, { status = "lobby", settings = '{"num_rounds": 1, "time_per_question": 30}' } = {}) {
  const id = randomUUID();
  const code = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  psql(`insert into rooms (id, code, host_id, game_mode, status, settings) values ('${id}', '${code}', '${host}', 'multiple-choice', '${status}', '${settings}');
    ${members.map((p) => `insert into room_players (room_id, player_id) values ('${id}', '${p}');`).join("\n")}`);
  made.rooms.push(id);
  return { id, code };
}
const question = (n, correct = "1:1") => ({
  prompt_verse_key: `1:${n}`,
  prompt_text: "q",
  correct_verse_key: correct,
  correct_text: "c",
  options: [{ verse_key: correct, text: "c" }, { verse_key: "2:255", text: "x" }],
  game_mode: "multiple-choice",
});
async function startedGame(players, rounds = 1, correct = "1:1") {
  const room = newRoom(players[0], players);
  const r = await call("start-game", { room_id: room.id, player_id: players[0], questions: Array.from({ length: rounds }, (_, i) => question(i + 1, correct)) });
  if (r.status !== 200) throw new Error(`start-game failed: ${JSON.stringify(r)}`);
  const round1 = psql(`select id from game_rounds where game_id='${r.body.game_id}' and round_number=1`);
  return { room, gameId: r.body.game_id, round1 };
}
function cleanup() {
  // Rooms made through create-room are found through their host.
  if (made.players.length) {
    const ps = made.players.map((p) => `'${p}'`).join(",");
    made.rooms.push(...psql(`select id from rooms where host_id in (${ps})`).split("\n").filter(Boolean));
  }
  if (!made.players.length) return;
  const ps = made.players.map((p) => `'${p}'`).join(",");
  const rs = made.rooms.length ? [...new Set(made.rooms)].map((r) => `'${r}'`).join(",") : "null";
  psql(`
    delete from round_answers where player_id in (${ps}) or round_id in (select gr.id from game_rounds gr join games g on g.id=gr.game_id where g.room_id in (${rs}));
    delete from game_rounds where game_id in (select id from games where room_id in (${rs}));
    delete from games where room_id in (${rs});
    delete from room_players where room_id in (${rs}) or player_id in (${ps});
    delete from rooms where id in (${rs});
    delete from verse_mistakes where player_id in (${ps});
    delete from players where id in (${ps});`);
}

const results = [];
function report(id, name, failedTrials, trials, detail) {
  const failed = failedTrials > 0;
  results.push({ id, failed });
  console.log(`${failed ? "not ok" : "ok"} - ${id}: ${name} (${failedTrials}/${trials} trials reproduced)${detail ? ` ${detail}` : ""}`);
}
function check(id, name, pass, detail) {
  results.push({ id, failed: !pass });
  console.log(`${pass ? "ok" : "not ok"} - ${id}: ${name}${detail ? ` ${detail}` : ""}`);
}

async function main() {
  try {
    // All six edge functions answer with main's reply shapes.
    {
      const [h, g] = newPlayers(2);
      const created = await call("create-room", { player_id: h, game_mode: "multiple-choice" });
      const roomId = created.body.room_id;
      if (roomId) made.rooms.push(roomId);
      const joined = await call("join-room", { player_id: g, room_code: created.body.code });
      const rejoined = await call("join-room", { player_id: g, room_code: String(created.body.code).toLowerCase() });
      const started = await call("start-game", { room_id: roomId, player_id: h, questions: [question(1), question(2)] });
      const round1 = started.body.game_id ? psql(`select id from game_rounds where game_id='${started.body.game_id}' and round_number=1`) : null;
      const answered = await call("submit-answer", { game_id: started.body.game_id, round_id: round1, player_id: h, answer_verse_key: "1:1" });
      const again = await call("submit-answer", { game_id: started.body.game_id, round_id: round1, player_id: h, answer_verse_key: "1:1" });
      const beat = await call("heartbeat-room", { room_id: roomId, player_id: g });
      const left = await call("leave-room", { room_id: roomId, player_id: g });
      const after = psql(`select r.ended_at is not null, (select count(*) from game_rounds where game_id='${started.body.game_id}' and started_at is not null) from game_rounds r where r.id='${round1}'`);
      const ok =
        created.status === 200 && typeof created.body.code === "string" &&
        joined.status === 200 && joined.body.room_id === roomId && joined.body.code === created.body.code && joined.body.host_id === h &&
        joined.body.game_mode === "multiple-choice" && typeof joined.body.settings === "object" &&
        rejoined.status === 200 &&
        started.status === 200 && Object.keys(started.body).sort().join() === "game_id,total_rounds" && started.body.total_rounds === 2 &&
        answered.status === 200 && JSON.stringify(answered.body) === '{"is_correct":true,"points_awarded":8}' &&
        again.status === 400 && again.body.error === "Already answered this round" &&
        beat.status === 200 && beat.body.ok === true &&
        left.status === 200 && left.body.status === "left" &&
        after === "t|2";
      check("edge", "create-room, join-room, start-game, submit-answer, heartbeat-room and leave-room work with main's replies", ok,
        ok ? "" : JSON.stringify({ created, joined, rejoined, started, answered, again, beat, left, after }));
    }

    // H1: the last two answers of the final round arrive together.
    let doubled = 0, statsDoubled = 0;
    let example = "";
    for (let t = 0; t < TRIALS; t++) {
      const [a, b] = newPlayers(2);
      const { room, gameId, round1 } = await startedGame([a, b]);
      await Promise.all([a, b].map((p) => call("submit-answer", { game_id: gameId, round_id: round1, player_id: p, answer_verse_key: "1:1" })));
      const awarded = Number(psql(`select coalesce(sum(points_awarded),0) from round_answers where round_id='${round1}'`));
      const scored = Number(psql(`select coalesce(sum(score),0) from room_players where room_id='${room.id}'`));
      const lifetime = Number(psql(`select coalesce(sum(total_points),0) from players where id in ('${a}','${b}')`));
      if (scored !== awarded) doubled++;
      if (lifetime !== awarded) statsDoubled++;
      if ((scored !== awarded || lifetime !== awarded) && !example) example = `e.g. answers awarded ${awarded}, room score ${scored}, lifetime total_points ${lifetime}`;
    }
    report("H1", "two final answers at once add the round's points once", doubled, TRIALS, example);
    report("H1", "two final answers at once add lifetime stats once", statsDoubled, TRIALS);

    // H1 path 2: an answer to a round that has already ended is refused and re-runs nothing.
    {
      const [a, b, c] = newPlayers(3);
      const { room, gameId, round1 } = await startedGame([a, b, c], 2);
      // c stops heartbeating, so a and b's answers end round 1.
      psql(`update room_players set last_seen_at = now() - interval '1 minute' where room_id='${room.id}' and player_id='${c}'`);
      await call("submit-answer", { game_id: gameId, round_id: round1, player_id: a, answer_verse_key: "1:1" });
      await call("submit-answer", { game_id: gameId, round_id: round1, player_id: b, answer_verse_key: "1:1" });
      const before = psql(`select coalesce(sum(score),0) from room_players where room_id='${room.id}'`);
      const ended = psql(`select ended_at is not null from game_rounds where id='${round1}'`);
      const late = await call("submit-answer", { game_id: gameId, round_id: round1, player_id: c, answer_verse_key: "1:1" });
      const after = psql(`select coalesce(sum(score),0) from room_players where room_id='${room.id}'`);
      const stored = psql(`select count(*) from round_answers where round_id='${round1}' and player_id='${c}'`);
      const bad = late.status === 200 || after !== before || stored !== "0" || ended !== "t";
      report("H1", "an answer to an ended round is refused and scores nothing", bad ? 1 : 0, 1,
        `(round ended: ${ended}; late answer -> ${late.status} ${JSON.stringify(late.body)}; room score ${before} -> ${after}; stored: ${stored})`);
    }

    // M3: two starts at once.
    let twoGames = 0;
    for (let t = 0; t < TRIALS; t++) {
      const [h, p] = newPlayers(2);
      const room = newRoom(h, [h, p]);
      await Promise.all([1, 2].map(() => call("start-game", { room_id: room.id, player_id: h, questions: [question(1)] })));
      if (Number(psql(`select count(*) from games where room_id='${room.id}'`)) !== 1) twoGames++;
    }
    report("M3", "two starts at once create one game", twoGames, TRIALS);

    // M3: speed bonus. Three correct answers at once in a 4-player round (round stays open).
    let dupBonus = 0;
    let bonusExample = "";
    for (let t = 0; t < TRIALS; t++) {
      const ps = newPlayers(4);
      const { round1, gameId } = await startedGame(ps);
      await Promise.all(ps.slice(0, 3).map((p) => call("submit-answer", { game_id: gameId, round_id: round1, player_id: p, answer_verse_key: "1:1" })));
      const pts = psql(`select string_agg(points_awarded::text, ',' order by points_awarded desc) from round_answers where round_id='${round1}'`);
      if (pts !== "8,7,6") { dupBonus++; bonusExample ||= `e.g. points ${pts} (expected 8,7,6)`; }
    }
    report("M3", "correct answers at once get the 1st/2nd/3rd bonus once each", dupBonus, TRIALS, bonusExample);

    // M3: buzzer. Two buzzes at once.
    let twoWinners = 0;
    for (let t = 0; t < TRIALS; t++) {
      const ps = newPlayers(3);
      const { round1, gameId } = await startedGame(ps);
      const rs = await Promise.all(ps.slice(0, 2).map((p) => call("submit-answer", { game_id: gameId, round_id: round1, player_id: p, is_buzzer: true })));
      if (rs.filter((r) => r.body.buzzer_winner).length !== 1) twoWinners++;
    }
    report("M3", "two buzzes at once have one winner", twoWinners, TRIALS);

    // M3: verse mistakes. One player answers wrong on the same verse in two games at once.
    let lost = 0;
    for (let t = 0; t < TRIALS; t++) {
      const [a, b] = newPlayers(2);
      const g1 = await startedGame([a, b], 1, "3:3");
      const g2 = await startedGame([a, b], 1, "3:3");
      await Promise.all([g1, g2].map((g) => call("submit-answer", { game_id: g.gameId, round_id: g.round1, player_id: a, answer_verse_key: "2:255" })));
      const count = Number(psql(`select coalesce(max(mistake_count),0) from verse_mistakes where player_id='${a}' and verse_key='3:3'`));
      if (count !== 2) lost++;
    }
    report("M3", "wrong answers at once on the same verse count every mistake", lost, TRIALS);

    // M3: room capacity. 7 players in a lobby, 3 join at once.
    let over = 0, maxActive = 0;
    for (let t = 0; t < TRIALS; t++) {
      const ps = newPlayers(10);
      const room = newRoom(ps[0], ps.slice(0, 7));
      await Promise.all(ps.slice(7).map((p) => call("join-room", { player_id: p, room_code: room.code })));
      const active = Number(psql(`select count(*) from room_players where room_id='${room.id}' and status='active'`));
      maxActive = Math.max(maxActive, active);
      if (active !== 8) over++;
    }
    report("M3", "joins at once fill a room to exactly 8 active players, never past", over, TRIALS, `(max active seen: ${maxActive})`);

    // H5: a round past its time_per_question, with every player still heartbeating and one
    // who never answers, is ended by the heartbeat's advance check.
    {
      const [a, b] = newPlayers(2);
      const { room, gameId, round1 } = await startedGame([a, b]);
      psql(`update game_rounds set started_at = now() - interval '10 minutes' where id='${round1}'`);
      const late = await call("submit-answer", { game_id: gameId, round_id: round1, player_id: a, answer_verse_key: "1:1" });
      const hb = await Promise.all([a, b].map((p) => call("heartbeat-room", { room_id: room.id, player_id: p })));
      const ended = psql(`select ended_at is not null from game_rounds where id='${round1}'`);
      const finished = psql(`select ended_at is not null from games where id='${gameId}'`);
      const settings = psql(`select settings->>'time_per_question' from rooms where id='${room.id}'`);
      report("H5", "a round past its time_per_question is ended by the heartbeat", ended === "t" && finished === "t" ? 0 : 1, 1,
        `(time_per_question ${settings}s, round open for 10 min, late answer -> ${late.status}, heartbeats ${hb.map((h) => h.status).join("/")}, round ended: ${ended}, game ended: ${finished})`);
    }

    // H5: a round inside its time is not ended early by a heartbeat.
    {
      const [a, b] = newPlayers(2);
      const { room, round1 } = await startedGame([a, b]);
      await Promise.all([a, b].map((p) => call("heartbeat-room", { room_id: room.id, player_id: p })));
      const ended = psql(`select ended_at is not null from game_rounds where id='${round1}'`);
      check("H5", "a round inside its time_per_question stays open after heartbeats", ended === "f", `(round ended: ${ended})`);
    }

    // Main's rules that 014 must keep (coordinator decision 2: L6, L19 and reply changes stay out).
    {
      // A player who left a lobby still cannot rejoin it (main's rule; L19 is not ported).
      const [h, p] = newPlayers(2);
      const room = newRoom(h, [h, p]);
      await call("leave-room", { room_id: room.id, player_id: p });
      const back = await call("join-room", { player_id: p, room_code: room.code });
      check("main", "a player who left a lobby cannot rejoin it", back.status === 403 && back.body.error === "You already left this game and cannot rejoin it.",
        `(${back.status} ${JSON.stringify(back.body)})`);

      // A full room refuses a join, also from a member already in it (main's order).
      const ps = newPlayers(8);
      const full = newRoom(ps[0], ps);
      const extra = newPlayers(1)[0];
      const refused = await call("join-room", { player_id: extra, room_code: full.code });
      const member = await call("join-room", { player_id: ps[3], room_code: full.code });
      check("main", "a full room refuses a join with main's message", refused.status === 400 && refused.body.error === "Room is full (max 8 players)" &&
        member.status === 400, `(${refused.status} ${JSON.stringify(refused.body)}; member ${member.status})`);

      // The winner is the top scorer, also on 0 points (main's rule; L6 is not ported).
      const [x, y] = newPlayers(2);
      const g = await startedGame([x, y], 1, "1:1");
      await call("submit-answer", { game_id: g.gameId, round_id: g.round1, player_id: x, answer_verse_key: "2:255" });
      await call("submit-answer", { game_id: g.gameId, round_id: g.round1, player_id: y, answer_verse_key: "2:255" });
      const winner = psql(`select coalesce(winner_id::text, 'none'), ended_at is not null from games where id='${g.gameId}'`);
      const wins = Number(psql(`select coalesce(sum(total_wins),0) from players where id in ('${x}','${y}')`));
      check("main", "a game where nobody scored still names one winner, as on main", /^[0-9a-f-]{36}\|t$/.test(winner) && wins === 1, `(${winner}; wins ${wins})`);
    }
  } finally {
    cleanup();
  }
  const failed = results.filter((r) => r.failed).length;
  console.log(failed ? `not ok - multiplayer: ${failed} of ${results.length} checks failed` : "ok - multiplayer: no race or stall reproduced");
  process.exit(failed ? 1 : 0);
}

void main();
