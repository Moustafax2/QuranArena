// Manual, trusted-operator utility. Never run against a restored database until
// it is isolated from users. Requires env vars; never prints keys or records.
const fs = require('node:fs');
require('@next/env').loadEnvConfig(process.cwd());
const [command, file, confirmation] = process.argv.slice(2);
async function main() {
  if (!['export-ledger','reapply-ledger'].includes(command) || !file) throw Error('Usage: node scripts/privacy-admin.cjs export-ledger FILE | reapply-ledger FILE --confirm-restore');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Error('Explicit hosted Supabase URL and service role configuration required.');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (command === 'export-ledger') {
    let ledger = [], offset = 0;
    while (true) {
      const r = await fetch(`${url}/rest/v1/privacy_erasure_ledger?select=player_id,deleted_at&order=player_id&limit=1000&offset=${offset}`, { headers });
      if (!r.ok) throw Error('Ledger export failed.');
      const rows = await r.json(); ledger.push(...rows);
      if (rows.length < 1000) break;
      offset += rows.length;
    }
    fs.writeFileSync(file, JSON.stringify(ledger), { flag: 'wx', mode: 0o600 });
    console.log(`Exported ${ledger.length} erasure records. Store this file outside the database backup with restricted access.`);
  } else {
    if (confirmation !== '--confirm-restore') throw Error('Restoration requires --confirm-restore and an isolated database.');
    const entries = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!Array.isArray(entries) || entries.length > 10000) throw Error('Expected a ledger array of at most 10000 entries; use a reviewed bulk restore procedure for larger ledgers.');
    const r = await fetch(`${url}/rest/v1/rpc/reapply_privacy_erasures`, { method:'POST', headers, body:JSON.stringify({ entries }) });
    if (!r.ok) throw Error('Restore suppression failed. Keep the restored database offline.');
    console.log('Erasures reapplied; restored sessions invalidated and consent withdrawn. Validate before reopening access.');
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
