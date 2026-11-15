import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authRequiredBody } from "@/lib/flashcard/auth-required";
import { clientErrorMessage } from "@/lib/public-error";
import { intParam } from "@/lib/api-validation";
import { fetchInChunks } from "@/lib/supabase/paging";

export async function GET(request: Request) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const supabase = createAdminSupabaseClient();

  // Non-numeric values used to become NaN and a 500 (audit L10).
  const requestedLimit = intParam(searchParams.get("limit"), 100, 1, Number.MAX_SAFE_INTEGER);
  const offset = intParam(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const ratingParam = searchParams.get("rating");
  const ratingValue = ratingParam ? intParam(ratingParam, 0, 1, 4) : 0;
  if (requestedLimit === null || offset === null || ratingValue === null) {
    return NextResponse.json({ error: "Invalid query." }, { status: 400, headers: cookieCarrier.headers });
  }
  const limit = Math.min(requestedLimit, 500);

  let query = supabase
    .from("review_log")
    .select("*")
    .eq("user_id", session.player_id);

  const sessionId = searchParams.get("session_id");
  const wordId = searchParams.get("word_id");
  const startDate = searchParams.get("start_date");
  const endDate = searchParams.get("end_date");

  if (sessionId) query = query.eq("session_id", sessionId);
  if (wordId) query = query.eq("word_id", wordId);
  if (ratingValue) query = query.eq("rating", ratingValue);
  if (startDate) query = query.gte("timestamp", startDate);
  if (endDate) query = query.lte("timestamp", endDate);

  // The client pages with offset/limit, so the order must be unique: reviews
  // that share a timestamp could otherwise repeat or go missing between pages
  // (A4 review #4; the same tie-breaker as M4's paged reads).
  query = query
    .order("timestamp", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not load reviews.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json(data, { headers: cookieCarrier.headers });
}

type ReviewBody = {
  id: string;
  card_id: string;
  word_id: string;
  rating: number;
  timestamp: string;
  session_id: string;
  review_duration_ms?: number | null;
  state_before: number;
  state_after: number;
};

// Accepts one review or an array (data migration). Writes are idempotent on
// the client-generated id, so a retried upload never fails on a duplicate.
export async function POST(request: Request) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as ReviewBody | ReviewBody[] | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: cookieCarrier.headers });
  }
  const logs = Array.isArray(body) ? body : [body];
  if (logs.length === 0) {
    return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
  }

  const supabase = createAdminSupabaseClient();

  // Attach each review to the user's own card for its word. The client's
  // card_id can differ (a local card that merged into an existing server card
  // keeps the server id), and must never point at someone else's card. A
  // review whose word has no card would fail the batch on the foreign key, so
  // it is dropped.
  // Every id goes into the request URL, so the lookup is chunked
  // (IN_CHUNK_SIZE ids per request) to stay within URL limits.
  const wordIds = [...new Set(logs.map((log) => log.word_id))];
  const cardForWord = new Map<string, string>();
  try {
    const owned = await fetchInChunks<{ id: string; word_id: string }>(wordIds, (chunk) =>
      supabase
        .from("user_flashcards")
        .select("id, word_id")
        .eq("user_id", session.player_id)
        .in("word_id", chunk)
    );
    for (const row of owned) cardForWord.set(row.word_id, row.id);
  } catch (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not save reviews.") }, { status: 500, headers: cookieCarrier.headers });
  }

  const rows = logs
    .filter((log) => cardForWord.has(log.word_id))
    .map((log) => ({
      id: log.id,
      user_id: session.player_id,
      card_id: cardForWord.get(log.word_id)!,
      word_id: log.word_id,
      rating: log.rating,
      timestamp: log.timestamp,
      session_id: log.session_id,
      review_duration_ms: log.review_duration_ms ?? null,
      state_before: log.state_before,
      state_after: log.state_after,
    }));
  if (rows.length > 0) {
    const { error } = await supabase
      .from("review_log")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) {
      return NextResponse.json({ error: clientErrorMessage(error, "Could not save reviews.") }, { status: 500, headers: cookieCarrier.headers });
    }
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}
