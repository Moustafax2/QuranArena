// Run with an isolated PGlite installation path; never connects to Supabase.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require(process.argv[2] || "@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;");
    const migrations = path.join(__dirname, "../supabase/migrations");
    const files = fs.readdirSync(migrations).filter(f => f.endsWith(".sql") && f < "009").sort();
    for (const file of files) await db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
    await db.exec("grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to anon, authenticated, service_role;");
    const [a, b, shared, alone, game, round, card, receipt] = Array.from({ length: 8 }, randomUUID);
    await db.query("insert into players(id,display_name,qf_email,quran_foundation_uid) values ($1,'private@example.test','private@example.test','qf-a'),($2,'Other',null,null)", [a,b]);
    await db.exec(fs.readFileSync(path.join(migrations, "009_privacy_controls.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(migrations, "010_privacy_lifecycle.sql"), "utf8"));
    assert.equal((await db.query("select display_name from players where id=$1", [a])).rows[0].display_name, "Player");
    await db.query("insert into rooms(id,code,host_id,game_mode) values ($1,'ABC123',$3,'multiple-choice'),($2,'DEF456',$3,'multiple-choice')", [shared,alone,a]);
    await db.query("insert into room_players(room_id,player_id) values ($1,$3),($1,$4),($2,$3)", [shared,alone,a,b]);
    await db.query("insert into games(id,room_id,total_rounds,winner_id) values ($1,$2,1,$3)", [game,shared,a]);
    await db.query("insert into game_rounds(id,game_id,round_number,prompt_verse_key,correct_verse_key) values ($1,$2,1,'1:1','1:2')", [round,game]);
    await db.query("insert into round_answers(round_id,player_id,is_correct) values ($1,$2,true),($1,$3,false)", [round,a,b]);
    await db.query("insert into verse_mistakes(player_id,verse_key) values ($1,'1:1')", [a]);
    await db.query("insert into friends(player_a,player_b,requested_by) values ($1,$2,$3)", [[a,b].sort()[0],[a,b].sort()[1],a]);
    await db.query("insert into game_invitations(room_id,inviter_player_id,invitee_qf_user_id,invitee_display_name) values ($1,$2,'qf-a','Player')", [shared,b]);
    await db.exec("insert into lexical_entries(word_id,type,canonical_form,translation,source) values ('test','NOUN','test','test','fixture')");
    await db.query("insert into user_flashcards(id,user_id,word_id,fsrs_state) values ($1,$2,'test','{}')", [card,a]);
    await db.query("insert into review_log(user_id,card_id,word_id,rating,session_id,state_before,state_after) values ($1,$2,'test',3,$3,0,1)", [a,card,randomUUID()]);
    await db.query("insert into user_preferences(user_id) values ($1)", [a]);
    await db.query("insert into memorization_attempts(player_id,client_attempt_id,mode,rating_level) values ($1,'attempt','ayah',2)", [a]);
    await db.query("insert into privacy_consents(id,player_id,version) values ($1,$2,'2026-10-24')", [receipt,a]);
    const exported = (await db.query("select export_player_data($1) as data", [a])).rows[0].data;
    for (const key of ["flashcards","reviews","memorization","mistakes","friends","invitations","consent"]) assert.equal(exported[key].length, 1, key);
    assert.equal(exported.answers.length, 1);
    assert.equal(exported.player.session_version, undefined);
    await db.query("select invalidate_player_sessions($1)", [a]);
    assert.equal((await db.query("select session_version from players where id=$1", [a])).rows[0].session_version, 1);
    await db.exec("set role anon");
    await assert.rejects(() => db.query("select id,display_name from players"));
    await assert.rejects(() => db.query("select qf_email from players"));
    await assert.rejects(() => db.query("select delete_player_data($1)", [a]));
    await assert.rejects(() => db.query("select export_player_data($1)", [a]));
    for (const table of ['rooms','room_players','games','game_rounds','round_answers','privacy_erasure_ledger','privacy_deletion_events']) await assert.rejects(() => db.query('select * from '+table));
    await assert.rejects(() => db.query("select purge_qf_user_data('qf-a','event')"));
    await assert.rejects(() => db.query("select cleanup_privacy_data()"));
    await db.exec("reset role");
    // Force a late failure and verify that earlier deletions roll back.
    await db.exec("create table deletion_blocker(player_id uuid references players(id))");
    await db.query("insert into deletion_blocker values ($1)", [a]);
    await assert.rejects(() => db.query("select delete_player_data($1)", [a]));
    assert.equal((await db.query("select count(*)::int as n from round_answers where player_id=$1", [a])).rows[0].n, 1);
    assert.equal((await db.query("select host_id from rooms where id=$1", [shared])).rows[0].host_id, a);
    await db.exec("drop table deletion_blocker");
    await db.query("select delete_player_data($1)", [a]);
    assert.equal((await db.query("select count(*)::int as n from players where id=$1", [a])).rows[0].n, 0);
    for (const table of ["user_flashcards","review_log","user_preferences","memorization_attempts","verse_mistakes","privacy_consents","friends","game_invitations"]) {
      assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
    }
    assert.equal((await db.query("select host_id from rooms where id=$1", [shared])).rows[0].host_id, b);
    assert.equal((await db.query("select count(*)::int as n from rooms where id=$1", [alone])).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int as n from round_answers where player_id=$1", [b])).rows[0].n, 1);
    assert.equal((await db.query("select winner_id from games where id=$1", [game])).rows[0].winner_id, null);
    await db.query("select delete_player_data($1)", [a]); // Idempotent retry.
    // Verified external deletion retries, guest TTL, all-device withdrawal,
    // and restore suppression exercise the same production SQL functions.
    const [qf, expired, recent, c1, c2] = Array.from({length:5},randomUUID);
    await db.query("insert into players(id,display_name,quran_foundation_uid,last_active_at) values ($1,'QF','provider-sub',now()-interval '2 days'),($2,'Old',null,now()-interval '25 hours'),($3,'Recent',null,now())",[qf,expired,recent]);
    await db.query("insert into privacy_consents(id,player_id,version) values ($1,$3,'v'),($2,$3,'v')",[c1,c2,qf]);
    await db.query('select withdraw_player_consent($1)',[qf]);
    assert.equal((await db.query('select count(*)::int n from privacy_consents where player_id=$1 and withdrawn_at is null',[qf])).rows[0].n,0);
    assert.equal((await db.query('select touch_guest_player($1) ok',[expired])).rows[0].ok,false);
    assert.equal((await db.query('select touch_guest_player($1) ok',[recent])).rows[0].ok,true);
    await db.query('select cleanup_privacy_data()');
    assert.equal((await db.query('select count(*)::int n from players where id=$1',[expired])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from players where id in ($1,$2)',[qf,recent])).rows[0].n,2);
    await db.query("select purge_qf_user_data('provider-sub','qf:delivery-1')");
    await db.query("select purge_qf_user_data('provider-sub','qf:delivery-1')");
    assert.equal((await db.query("select count(*)::int n from privacy_deletion_events where event_id='qf:delivery-1'")).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from players where id=$1',[qf])).rows[0].n,0);
    const ledger=(await db.query('select player_id,deleted_at from privacy_erasure_ledger where player_id=$1',[qf])).rows;
    await db.query("insert into players(id,display_name,quran_foundation_uid) values ($1,'Restored','provider-sub')",[qf]);
    await db.query('select reapply_privacy_erasures($1::jsonb)',[JSON.stringify(ledger)]);
    assert.equal((await db.query('select count(*)::int n from players where id=$1',[qf])).rows[0].n,0);
    console.log("Lifecycle tests passed: guest expiry, external deletion replay, account withdrawal, restricted game reads, restore suppression.");
    console.log("Privacy SQL tests passed: complete export, column permissions, session invalidation, atomic rollback, deletion cascades, shared-history preservation, idempotency.");
  } finally { await db.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
