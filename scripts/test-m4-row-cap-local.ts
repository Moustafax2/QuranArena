// M4 (the non-flashcard reads) against the LOCAL Supabase stack's real
// PostgREST, which has max_rows = 1000 (supabase/config.toml, the same as
// hosted) and refuses a URL longer than about 8 KB.
//
// LOCAL stack only. Not part of `npm test` (src/lib/data/row-cap.test.ts is
// the pure counterpart). Run from the repo root:
//   npx tsx scripts/test-m4-row-cap-local.ts
// It reads only the *_LOCAL Supabase entries of .env.development.local, never
// prints them, refuses any URL that is not 127.0.0.1 or localhost, and blocks
// every other outbound fetch. It makes a throwaway player with 1,500
// memorization attempts and 1,800 answered rounds through
// `docker exec ... psql`, calls the real memorization GET handler (only the
// session lookup is replaced) and getPlayerPlayProgress, then deletes every
// row it made.
//
// Exit 1 while a read stops at 1,000 rows or a failed query passes for an
// empty result; exit 0 when both reads return every row.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadWithMocks } from "../src/lib/flashcard/api-routes.test";

const repo = process.cwd();
const env: Record<string, string> = {};
for (const line of readFileSync(path.join(repo, ".env.development.local"), "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].replace(/^"|"$/g, "");
}
const localUrl = env.NEXT_PUBLIC_SUPABASE_URL_LOCAL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(localUrl) || !env.SUPABASE_SERVICE_ROLE_KEY_LOCAL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL) {
  console.error("refusing: .env.development.local has no local Supabase URL and keys");
  process.exit(1);
}
// Only the local entries, so the admin client cannot fall back to another project.
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[name];
process.env.NEXT_PUBLIC_SUPABASE_TARGET = "local";
process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL = localUrl;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL = env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL;
process.env.SUPABASE_SERVICE_ROLE_KEY_LOCAL = env.SUPABASE_SERVICE_ROLE_KEY_LOCAL;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return Promise.reject(new Error(`fenced: ${url.host}`));
  return realFetch(input, init);
}) as typeof fetch;

const psql = (sql: string) =>
  execFileSync("docker", ["exec", "-i", "supabase_db_quran-hackathon", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
  }).trim();

const PLAYER = "00000000-0000-4000-8000-0000000000a4";
const ROOM = "00000000-0000-4000-8000-0000000000b4";
const GAME = "00000000-0000-4000-8000-0000000000c4";
const ATTEMPTS = 1500;
const ANSWERS = 1800;

function cleanup() {
  psql(`
    delete from round_answers where player_id = '${PLAYER}';
    delete from verse_mistakes where player_id = '${PLAYER}';
    delete from game_rounds where game_id = '${GAME}';
    delete from games where id = '${GAME}';
    delete from room_players where room_id = '${ROOM}';
    delete from rooms where id = '${ROOM}';
    delete from memorization_attempts where player_id = '${PLAYER}';
    delete from players where id = '${PLAYER}';`);
}

async function main() {
  cleanup();
  psql(`
    insert into players (id, display_name) values ('${PLAYER}', 'M4 row-cap check');
    insert into memorization_attempts (player_id, client_attempt_id, mode, rating_level, verse_key, tested_at)
      select '${PLAYER}', 'm4-' || g, 'ayah', 1, '1:1', timestamptz '2026-01-01' + g * interval '1 minute'
      from generate_series(1, ${ATTEMPTS}) g;
    insert into rooms (id, code, host_id, game_mode, status) values ('${ROOM}', 'M4CHEK', '${PLAYER}', 'multiple-choice', 'finished');
    insert into games (id, room_id, total_rounds, ended_at) values ('${GAME}', '${ROOM}', ${ANSWERS}, now());
    insert into game_rounds (game_id, round_number, prompt_verse_key, correct_verse_key, game_mode, prompt_surah_id, prompt_juz_number, prompt_page_number, started_at, ended_at)
      select '${GAME}', g, '1:1', '1:1', 'multiple-choice', 1, 1, 1, now(), now() from generate_series(1, ${ANSWERS}) g;
    insert into round_answers (round_id, player_id, answer_verse_key, is_correct, points_awarded, server_received_at)
      select id, '${PLAYER}', '1:1', true, 5, timestamptz '2026-01-01' + round_number * interval '1 minute'
      from game_rounds where game_id = '${GAME}';`);

  const failures: string[] = [];
  try {
    const route = loadWithMocks<{ GET: (request: Request) => Promise<Response> }>(
      path.join(repo, "src/app/api/memorization/attempts/route.ts"),
      { "@/lib/multiplayer/resolve-player": { resolvePlayerId: async () => PLAYER } },
    );
    const response = await route.GET(new Request("http://localhost:3000/api/memorization/attempts"));
    const body = (await response.json()) as { attempts?: Array<{ client_attempt_id: string }> };
    const got = body.attempts?.length ?? 0;
    const hasNewest = body.attempts?.some((a) => a.client_attempt_id === `m4-${ATTEMPTS}`) ?? false;
    console.log(`memorization GET: status ${response.status}, ${got} of ${ATTEMPTS} attempts, newest present: ${hasNewest}`);
    if (got !== ATTEMPTS || !hasNewest) failures.push(`memorization GET returned ${got} of ${ATTEMPTS} (newest ${hasNewest ? "present" : "missing"})`);

    const { getPlayerPlayProgress } = loadWithMocks<{ getPlayerPlayProgress: (id: string) => Promise<{ events: unknown[] }> }>(
      path.join(repo, "src/lib/progress/play-server.ts"),
      {},
    );
    let events = -1;
    let thrown: unknown = null;
    try {
      events = (await getPlayerPlayProgress(PLAYER)).events.length;
    } catch (error) {
      thrown = error;
    }
    const reason = thrown && typeof thrown === "object" && "message" in thrown ? String(thrown.message).slice(0, 120) : String(thrown);
    console.log(`progress: ${thrown ? `threw ${reason}` : `${events} of ${ANSWERS} play events`}`);
    if (events !== ANSWERS) failures.push(`progress returned ${thrown ? "an error" : events} of ${ANSWERS} play events`);
  } finally {
    cleanup();
    const left = psql(`select (select count(*) from players where id = '${PLAYER}') + (select count(*) from rooms where id = '${ROOM}')`);
    if (left !== "0") failures.push(`cleanup left ${left} rows`);
  }

  if (failures.length) {
    console.log(`not ok - M4 (real PostgREST): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("ok - M4 (real PostgREST): memorization and progress read past the 1000-row cap");
}

main().catch((error) => {
  console.error("not ok - M4 (real PostgREST): the check could not run:", error instanceof Error ? error.message : error);
  process.exit(1);
});
