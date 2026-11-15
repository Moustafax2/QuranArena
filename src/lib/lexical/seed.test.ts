import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fakeSupabase } from "@/lib/flashcard/api-routes.test";

// M1: lexical_entries used to be seeded by POST /api/admin/seed-lexical, which
// had no check at all. main's proxy lets an anonymous same-origin POST through
// (consent is asked only at sign-in), so any visitor could make the server run
// 22 service-role upserts. Seeding is now an operator script
// (scripts/seed-lexical.ts) built on src/lib/lexical/seed.ts.

const ROOT = path.resolve(__dirname, "../../..");

async function runCase(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`ok - ${name}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// A write is .from("lexical_entries") followed by insert, upsert, update or
// delete. Reads (the flashcard import checks which word ids exist) are fine.
const LEXICAL_WRITE = /\.from\(\s*["'`]lexical_entries["'`]\s*\)\s*\.\s*(insert|upsert|update|delete)\s*\(/;

export async function runLexicalSeedTests() {
  await runCase("M1: no web route or server code under src/app can seed the lexical table", () => {
    assert.equal(
      existsSync(path.join(ROOT, "src/app/api/admin/seed-lexical/route.ts")),
      false,
      "the unauthenticated seed route still exists"
    );
    const writers = walk(path.join(ROOT, "src/app"))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => LEXICAL_WRITE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    assert.deepEqual(writers, [], "code under src/app still writes lexical_entries");
  });

  await runCase("M1: the seed helper upserts every entry in batches on word_id and reports failed batches", async () => {
    const { seedLexicalEntries, toLexicalRow } = await import("@/lib/lexical/seed");
    const entries = Array.from({ length: 450 }, (_, i) => ({
      id: `w${i}`, type: "NOUN", canonical_form: `f${i}`, translation: `t${i}`,
    }));
    const supabase = fakeSupabase((op) =>
      op.action === "upsert" && (op.payload as unknown[]).length === 50 ? { error: { message: "boom" } } : {}
    );
    const result = await seedLexicalEntries(supabase.client as never, entries);
    const upserts = supabase.ops.filter((op) => op.table === "lexical_entries" && op.action === "upsert");
    assert.deepEqual(upserts.map((op) => (op.payload as unknown[]).length), [200, 200, 50]);
    assert.ok(upserts.every((op) => op.options?.onConflict === "word_id"));
    assert.deepEqual(result, { total: 450, inserted: 400, failedBatches: ["400-450"] });
    assert.deepEqual(toLexicalRow(entries[0]), {
      word_id: "w0", type: "NOUN", canonical_form: "f0", root: null, lemma: null, forms: null,
      translation: "t0", arabic_explanation: null, examples: [], source: "corpus", frequency: null,
    });
  });
}
