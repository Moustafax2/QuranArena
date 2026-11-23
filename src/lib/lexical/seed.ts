import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ExampleReference, NounForms, VerbForms } from "@/lib/supabase/types";

// Seeds lexical_entries from public/data/lexical-db.json. It used to be an
// unauthenticated POST route (audit M1); it now runs only from
// scripts/seed-lexical.ts, by an operator holding the service-role key.

type LexicalInsert = Database["public"]["Tables"]["lexical_entries"]["Insert"];

const BATCH_SIZE = 200;

export function toLexicalRow(e: Record<string, unknown>): LexicalInsert {
  return {
    word_id: e.id as string,
    type: e.type as "VERB" | "NOUN" | "PARTICLE",
    canonical_form: e.canonical_form as string,
    root: (e.root as string | null) ?? null,
    lemma: (e.lemma as string | null) ?? null,
    forms: (e.forms as VerbForms | NounForms | null) ?? null,
    translation: e.translation as string,
    arabic_explanation: (e.arabic_explanation as string | null) ?? null,
    examples: (e.examples as ExampleReference[]) ?? [],
    source: (e.source as string) ?? "corpus",
    frequency: (e.frequency as number | null) ?? null,
  };
}

/** Upserts the entries on word_id in batches. A failed batch is reported and the rest still run. */
export async function seedLexicalEntries(
  supabase: SupabaseClient<Database>,
  entries: Array<Record<string, unknown>>
): Promise<{ total: number; inserted: number; failedBatches: string[] }> {
  let inserted = 0;
  const failedBatches: string[] = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE).map(toLexicalRow);
    const { error } = await supabase.from("lexical_entries").upsert(batch, { onConflict: "word_id" });
    if (error) {
      console.error(`Lexical seed batch ${i}-${i + batch.length} failed:`, error.message);
      failedBatches.push(`${i}-${i + batch.length}`);
    } else {
      inserted += batch.length;
    }
  }

  return { total: entries.length, inserted, failedBatches };
}
