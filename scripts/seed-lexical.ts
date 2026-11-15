// Seeds the lexical_entries table from public/data/lexical-db.json.
//
// This replaces the old POST /api/admin/seed-lexical route, which anyone could
// call (audit M1). It needs the service-role key, so it runs only from a
// machine that already has it. It loads no env file by itself: pass one
// explicitly. For the local Supabase stack:
//
//   npx tsx --env-file=.env.development.local scripts/seed-lexical.ts
//
// It reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or their
// _LOCAL variants when NEXT_PUBLIC_SUPABASE_TARGET=local, and stops with an
// error if they are not set. It prints the target and host before writing;
// check them. The upsert is keyed on word_id, so running it again is safe.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { getSupabaseAdminConfig } from "../src/lib/supabase/env";
import { seedLexicalEntries } from "../src/lib/lexical/seed";

async function main() {
  const { url, serviceRoleKey, target } = getSupabaseAdminConfig();
  const supabase = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const filePath = path.join(process.cwd(), "public", "data", "lexical-db.json");
  const db = JSON.parse(await readFile(filePath, "utf-8")) as { entries?: Array<Record<string, unknown>> };
  if (!db.entries?.length) throw new Error("No entries found in lexical-db.json.");

  console.log(`Seeding ${db.entries.length} lexical entries into the ${target} project (${new URL(url).host})...`);
  const result = await seedLexicalEntries(supabase, db.entries);
  console.log(`Done: ${result.inserted}/${result.total} upserted.`);
  if (result.failedBatches.length > 0) {
    console.error(`Failed batches: ${result.failedBatches.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
