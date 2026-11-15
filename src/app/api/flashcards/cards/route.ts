import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authRequiredBody } from "@/lib/flashcard/auth-required";
import type { Database } from "@/lib/supabase/types";
import { clientErrorMessage } from "@/lib/public-error";
import { fetchAllPages } from "@/lib/supabase/paging";
import { isStorableCardBody } from "@/lib/api-validation";

type CardInsert = Database["public"]["Tables"]["user_flashcards"]["Insert"];
type CardBody = Omit<CardInsert, "user_id">;

// A new or imported card must carry an FSRS state, and both scheduler states
// must have the stored shape (audit L10). A bad status, word id or date would
// fail the whole write in the database, so they are checked too (A4 review #5).
function isCardBody(card: unknown): card is CardBody {
  return isStorableCardBody(card);
}

// Everything except `id`. The table's conflict key is (user_id, word_id), so
// an upsert that sends `id` would rewrite the primary key of an existing card,
// which review_log rows reference.
function cardFields(card: CardBody, userId: string): CardInsert {
  return {
    user_id: userId,
    word_id: card.word_id,
    status: card.status,
    fsrs_state: card.fsrs_state,
    created_at: card.created_at,
    source_surah_id: card.source_surah_id ?? null,
    source_ayah_number: card.source_ayah_number ?? null,
    source_juz_number: card.source_juz_number ?? null,
    source_page_number: card.source_page_number ?? null,
    // Only sent when present. The PUT merge below also treats null as absent,
    // so importing cards without a Classic state keeps the stored one.
    ...(card.sm2_state !== undefined ? { sm2_state: card.sm2_state } : {}),
  };
}

export async function GET(request: Request) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const supabase = createAdminSupabaseClient();
  try {
    // A deck can pass the API's 1000-row cap (audit M4), so read every page.
    const data = await fetchAllPages((from, to) =>
      supabase
        .from("user_flashcards")
        .select("*")
        .eq("user_id", session.player_id)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
    return NextResponse.json(data, { headers: cookieCarrier.headers });
  } catch (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not load flashcards.") }, { status: 500, headers: cookieCarrier.headers });
  }
}

// Add one card, or an array of cards in one request (intake). Words that are
// already in the deck are left untouched.
export async function POST(request: Request) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as CardBody | CardBody[] | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: cookieCarrier.headers });
  }
  const cards = Array.isArray(body) ? body : [body];
  if (cards.length === 0) {
    return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
  }
  if (!cards.every(isCardBody)) {
    return NextResponse.json({ error: "Invalid flashcard." }, { status: 400, headers: cookieCarrier.headers });
  }

  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from("user_flashcards").upsert(
    cards.map((card) => ({ id: card.id, ...cardFields(card, session.player_id) })),
    { onConflict: "user_id,word_id", ignoreDuplicates: true }
  );

  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not save flashcards.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}

// Batch import: merge into existing cards (keeping their ids) and insert new
// ones with the client's id.
export async function PUT(request: Request) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as unknown[] | null;
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "Expected an array." }, { status: 400, headers: cookieCarrier.headers });
  }
  // Malformed cards are skipped and counted rather than failing the batch:
  // this is also the sign-in migration, which a single corrupt local card
  // would otherwise block on every load. The reply says which ones (their
  // positions in the body), so the client can keep them (A4 review #5).
  const cards = body.filter(isCardBody);
  const skippedIndexes = body.flatMap((card, index) => (isCardBody(card) ? [] : [index]));
  const skipped = skippedIndexes.length;
  const reply = skipped ? { ok: true, skipped, skipped_indexes: skippedIndexes } : { ok: true };
  if (cards.length === 0) {
    return NextResponse.json(reply, { headers: cookieCarrier.headers });
  }

  const supabase = createAdminSupabaseClient();

  // 1. Insert the words that aren't in the deck yet, keeping the client id.
  const inserted = await supabase
    .from("user_flashcards")
    .upsert(
      cards.map((card: CardBody) => ({ id: card.id, ...cardFields(card, session.player_id) })),
      { onConflict: "user_id,word_id", ignoreDuplicates: true }
    );
  if (inserted.error) {
    return NextResponse.json({ error: clientErrorMessage(inserted.error, "Could not import flashcards.") }, { status: 500, headers: cookieCarrier.headers });
  }

  // 2. Merge the imported state into every matching card without sending id.
  // supabase-js sends one column list per batch and fills a key a row lacks
  // with NULL, so cards that carry a Classic state are merged in their own
  // batch; the others don't send sm2_state and keep the stored one.
  const rows = cards.map((card: CardBody) =>
    cardFields({ ...card, sm2_state: card.sm2_state ?? undefined }, session.player_id)
  );
  for (const batch of [rows.filter((row) => "sm2_state" in row), rows.filter((row) => !("sm2_state" in row))]) {
    if (batch.length === 0) continue;
    const merged = await supabase
      .from("user_flashcards")
      .upsert(batch, { onConflict: "user_id,word_id" });
    if (merged.error) {
      return NextResponse.json({ error: clientErrorMessage(merged.error, "Could not import flashcards.") }, { status: 500, headers: cookieCarrier.headers });
    }
  }

  return NextResponse.json(reply, { headers: cookieCarrier.headers });
}
