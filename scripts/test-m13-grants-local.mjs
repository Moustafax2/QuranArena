// M13: the browser roles (anon, authenticated) must have no direct access to app
// tables or functions, while service_role keeps everything the server uses.
//
// LOCAL Supabase stack only. Not part of `npm test`. Run from the repo root:
//   node scripts/test-m13-grants-local.mjs
// It reads the local URL and keys from .env.development.local (the *_LOCAL
// entries), or else from `npx supabase status -o env`, and never prints them.
// It refuses any URL that is not 127.0.0.1 or localhost. It talks to the local
// Kong (GoTrue, PostgREST) and to the local Postgres container through
// `docker exec ... psql`, and removes everything it creates.
//
// Exit 1 while migration 012_revoke_client_grants.sql is missing, exit 0 after.
// Supabase Auth sign-up stays on in the local config.toml (turning it off on the
// hosted project is a deploy step), so an open sign-up is reported as a note,
// and the signed-up user's access is what is checked.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
}

function loadConfig() {
  if (existsSync(".env.development.local")) {
    const env = parseEnv(readFileSync(".env.development.local", "utf8"));
    const cfg = {
      base: env.NEXT_PUBLIC_SUPABASE_URL_LOCAL,
      anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL,
      service: env.SUPABASE_SERVICE_ROLE_KEY_LOCAL,
    };
    if (cfg.base && cfg.anon && cfg.service) return cfg;
  }
  const out = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
  const env = parseEnv(out);
  return { base: env.API_URL, anon: env.ANON_KEY, service: env.SERVICE_ROLE_KEY };
}

const { base, anon, service } = loadConfig();
if (!base || !anon || !service) throw new Error("missing local Supabase URL or keys");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(base)) throw new Error("refusing: not a local Supabase URL");
const api = base.replace(/\/$/, "");

const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
if (!projectId) throw new Error("project_id not found in supabase/config.toml");
const psql = (sql) =>
  execFileSync("docker", ["exec", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const lines = (s) => (s ? s.split("\n") : []);

let failures = 0;
function check(ok, name, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok" : "not ok"} - M13: ${name}${detail ? ` (${detail})` : ""}`);
}
const note = (s) => console.log(`# note: ${s}`);

const anonHeaders = { apikey: anon, authorization: `Bearer ${anon}`, "content-type": "application/json" };
const serviceHeaders = { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" };
const rest = (path, headers, init = {}) => fetch(`${api}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
const rpc = (fn, headers, args) => rest(`rpc/${fn}`, headers, { method: "POST", body: JSON.stringify(args) });

// Tables and functions the server routes (src/) and the edge functions
// (supabase/functions/) reach through the service-role client.
const APP_TABLES = [
  "friends", "game_invitations", "game_rounds", "games", "lexical_entries", "memorization_attempts", "players",
  "privacy_consents", "review_log", "room_players", "rooms", "round_answers", "user_flashcards", "user_preferences",
  "verse_mistakes",
];
const SERVICE_FUNCTIONS = [
  "export_player_data(uuid)", "delete_player_data(uuid)", "purge_qf_user_data(text,text)", "withdraw_player_consent(uuid)",
  "invalidate_player_sessions(uuid)", "touch_guest_player(uuid)", "increment_player_score(uuid,uuid,integer)",
  "increment_player_stats(uuid,integer,boolean)", "reapply_privacy_erasures(jsonb)", "cleanup_privacy_data()",
];

const created = { authUser: null, players: [], deliveryIds: [] };
try {
  // ---- Catalog: the browser roles hold nothing in `public` ----
  const tableGrants = lines(psql(
    "select grantee||':'||table_name||':'||privilege_type from information_schema.role_table_grants " +
      "where table_schema='public' and grantee in ('anon','authenticated','PUBLIC') order by 1",
  ));
  check(tableGrants.length === 0, "anon/authenticated hold no table privileges in public", `${tableGrants.length} grant rows`);

  const seqGrants = lines(psql(
    "select r||':'||c.relname from pg_class c cross join unnest(array['anon','authenticated']) r " +
      "where c.relnamespace='public'::regnamespace and c.relkind='S' " +
      "and (has_sequence_privilege(r, c.oid, 'usage') or has_sequence_privilege(r, c.oid, 'select') or has_sequence_privilege(r, c.oid, 'update'))",
  ));
  check(seqGrants.length === 0, "anon/authenticated hold no sequence privileges in public", `${seqGrants.length}`);

  const fnGrants = lines(psql(
    "select r||':'||p.oid::regprocedure from pg_proc p cross join unnest(array['anon','authenticated']) r " +
      "where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') " +
      "and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') " +
      "and has_function_privilege(r, p.oid, 'execute') order by 1",
  ));
  check(fnGrants.length === 0, "no public function is executable by anon/authenticated", fnGrants.slice(0, 6).join(", "));

  const legacyPolicies = lines(psql(
    "select tablename||'.'||policyname from pg_policies where schemaname='public' " +
      "and (coalesce(qual,'') ilike '%auth.uid()%' or coalesce(with_check,'') ilike '%auth.uid()%' or coalesce(qual,'') = 'true')",
  ));
  check(legacyPolicies.length === 0, "no legacy auth.uid()/open policies remain", `${legacyPolicies.length} policies`);

  // ---- Live: the anon key alone ----
  const tables = lines(psql("select tablename from pg_tables where schemaname='public' order by 1"));
  const anonReadable = [];
  for (const t of tables) {
    const r = await rest(`${t}?select=*&limit=1`, anonHeaders);
    if (r.ok) anonReadable.push(`${t} ${r.status}`);
  }
  check(anonReadable.length === 0, "the anon key reads no public table through PostgREST", anonReadable.join(", "));

  const anonRpc = await rpc("increment_player_stats", anonHeaders, { p_player_id: randomUUID(), p_points: 1, p_won: false });
  check(!anonRpc.ok, "the anon key cannot call increment_player_stats", `${anonRpc.status}`);

  // ---- Live: a Supabase Auth user made with the anon key ----
  const email = `m13-${randomUUID().slice(0, 8)}@example.test`;
  const su = await fetch(`${api}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password: `m13-${randomUUID()}` }),
  });
  const suBody = await su.json().catch(() => ({}));
  const jwt = suBody.access_token;
  created.authUser = suBody.user?.id ?? null;
  if (su.ok && jwt) {
    note("Supabase Auth sign-up is open on this local stack (config.toml). Turn it off on the hosted project; that is a deploy step, not part of 012.");
    const uid = created.authUser;
    const auth = { apikey: anon, authorization: `Bearer ${jwt}`, "content-type": "application/json", prefer: "return=minimal" };
    const victimSub = `m13-victim-${randomUUID().slice(0, 8)}`;

    const ins = await rest("players", auth, { method: "POST", body: JSON.stringify({ id: uid, quran_foundation_uid: victimSub, display_name: "m13" }) });
    if (ins.ok) created.players.push(uid);
    check(!ins.ok, "a signed-up user cannot pre-claim a QF uid by inserting a players row", `${ins.status}`);

    const st = await rpc("increment_player_stats", auth, { p_player_id: uid, p_points: 100000, p_won: true });
    check(!st.ok, "a signed-up user cannot call increment_player_stats", `${st.status}`);

    const pref = await rest("user_preferences", auth, { method: "POST", body: JSON.stringify({ user_id: uid }) });
    check(!pref.ok, "a signed-up user cannot write user_preferences", `${pref.status}`);

    const readable = [];
    for (const t of tables) {
      const r = await rest(`${t}?select=*&limit=1`, auth);
      if (r.ok) readable.push(`${t} ${r.status}`);
    }
    check(readable.length === 0, "a signed-up user reads no public table through PostgREST", readable.join(", "));

    if (ins.ok) {
      // The app adopts an existing players row by QF sub at sign-in
      // (upsertPlayerFromQfUser); a row it stores there must stay private.
      psql(`insert into memorization_attempts (player_id, client_attempt_id, mode, rating_level, verse_key) values ('${uid}', 'victim-1', 'ayah', 2, '1:1')`);
      const rd = await rest("memorization_attempts?select=client_attempt_id", auth);
      const rows = rd.ok ? await rd.json() : [];
      check(!rows.some((r) => r.client_attempt_id === "victim-1"), "the attacker's JWT cannot read study data stored for a pre-claimed account");
    }
  } else if (su.status >= 500) {
    // GoTrue is down (for example still restarting after a db reset): the
    // signed-up-user checks did not run, so this run proves less.
    check(false, "GoTrue answered the sign-up request", `${su.status}; retry once the auth container is up`);
  } else {
    note(`Supabase Auth sign-up refused (${su.status}); the signed-up-user checks are covered by the catalog checks above.`);
  }

  // ---- service_role keeps everything the server and edge functions use ----
  const serviceTableFails = [];
  for (const t of APP_TABLES) {
    const r = await rest(`${t}?select=*&limit=1`, serviceHeaders);
    if (r.status !== 200) serviceTableFails.push(`${t} ${r.status}`);
  }
  check(serviceTableFails.length === 0, "service_role reads every table the app uses", serviceTableFails.join(", "));

  const serviceFnFails = SERVICE_FUNCTIONS.filter((f) => psql(`select has_function_privilege('service_role', 'public.${f}', 'execute')`) !== "t");
  check(serviceFnFails.length === 0, "service_role can execute every function the app, edge functions and operator scripts call", serviceFnFails.join(", "));
  check(
    psql("select has_function_privilege('service_role', 'public.delete_player_data_core(uuid)', 'execute')") === "f",
    "delete_player_data_core stays closed to service_role (main's 010)",
  );

  // Throwaway guest player: exercise each RPC through PostgREST as service_role.
  const mk = await rest("players", serviceHeaders, {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ display_name: "m13-throwaway" }),
  });
  const guest = mk.ok ? (await mk.json())[0]?.id : null;
  if (guest) created.players.push(guest);
  check(Boolean(guest), "service_role inserts a players row", `${mk.status}`);

  if (guest) {
    const touch = await rpc("touch_guest_player", serviceHeaders, { target_player: guest });
    check(touch.ok && (await touch.json()) === true, "service_role: touch_guest_player", `${touch.status}`);

    const stats = await rpc("increment_player_stats", serviceHeaders, { p_player_id: guest, p_points: 7, p_won: true });
    const after = await (await rest(`players?id=eq.${guest}&select=total_points,total_wins`, serviceHeaders)).json();
    check(stats.ok && after[0]?.total_points === 7 && after[0]?.total_wins === 1, "service_role: increment_player_stats updates the player", `${stats.status}`);

    const score = await rpc("increment_player_score", serviceHeaders, { p_room_id: randomUUID(), p_player_id: guest, p_delta: 3 });
    check(score.ok, "service_role: increment_player_score", `${score.status}`);

    const inv = await rpc("invalidate_player_sessions", serviceHeaders, { target_player: guest });
    check(inv.ok, "service_role: invalidate_player_sessions", `${inv.status}`);

    const p1 = await rest("user_preferences", serviceHeaders, { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ user_id: guest }) });
    const m1 = await rest("memorization_attempts", serviceHeaders, {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ player_id: guest, client_attempt_id: "m13-1", mode: "ayah", rating_level: 1, verse_key: "1:1" }),
    });
    check(p1.ok && m1.ok, "service_role writes user_preferences and memorization_attempts", `${p1.status}/${m1.status}`);

    const ex = await rpc("export_player_data", serviceHeaders, { target_player: guest });
    const exBody = ex.ok ? await ex.json() : {};
    check(
      ex.ok && exBody.player?.id === guest && exBody.preferences?.user_id === guest && exBody.memorization?.length === 1,
      "service_role: export_player_data returns the player's records",
      `${ex.status}`,
    );

    const wd = await rpc("withdraw_player_consent", serviceHeaders, { target_player: guest });
    check(wd.ok, "service_role: withdraw_player_consent", `${wd.status}`);

    const del = await rpc("delete_player_data", serviceHeaders, { target_player: guest });
    const gone = await (await rest(`players?id=eq.${guest}&select=id`, serviceHeaders)).json();
    const goneMem = await (await rest(`memorization_attempts?player_id=eq.${guest}&select=id`, serviceHeaders)).json();
    const goneAll = Array.isArray(gone) && gone.length === 0 && Array.isArray(goneMem) && goneMem.length === 0;
    check(del.ok && goneAll, "service_role: delete_player_data removes the player and their records", `${del.status}`);
  }

  // Throwaway QF-linked player: the verified QF deletion path.
  const sub = `m13-qf-${randomUUID().slice(0, 8)}`;
  const mkq = await rest("players", serviceHeaders, {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ display_name: "m13-throwaway-qf", quran_foundation_uid: sub }),
  });
  const qfPlayer = mkq.ok ? (await mkq.json())[0]?.id : null;
  if (qfPlayer) {
    created.players.push(qfPlayer);
    const delivery = `m13-${randomUUID()}`;
    created.deliveryIds.push(delivery);
    const pq = await rpc("purge_qf_user_data", serviceHeaders, { subject_id: sub, delivery_id: delivery });
    const goneQ = await (await rest(`players?id=eq.${qfPlayer}&select=id`, serviceHeaders)).json();
    check(pq.ok && Array.isArray(goneQ) && goneQ.length === 0, "service_role: purge_qf_user_data removes the QF-linked player", `${pq.status}`);
  } else {
    check(false, "service_role inserts a QF-linked players row", `${mkq.status}`);
  }
} finally {
  const ids = created.players.filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    psql(
      `delete from memorization_attempts where player_id in (${list}); delete from user_preferences where user_id in (${list}); ` +
        `delete from players where id in (${list}); delete from privacy_erasure_ledger where player_id in (${list});`,
    );
  }
  if (created.deliveryIds.length) psql(`delete from privacy_deletion_events where event_id in (${created.deliveryIds.map((d) => `'${d}'`).join(",")})`);
  if (created.authUser && /^[0-9a-f-]{36}$/.test(created.authUser)) psql(`delete from auth.users where id='${created.authUser}'`);
}

if (failures) {
  console.log(`not ok - M13: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok - M13: the browser roles have no direct access, and service_role keeps what the server uses");
