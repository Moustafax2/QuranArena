import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { flashcardSession } from "@/lib/flashcard/auth-required";
import { clientErrorMessage } from "@/lib/public-error";
import { hasValidCardStates } from "@/lib/api-validation";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const cookieCarrier = new NextResponse();
  const auth = await flashcardSession(request, cookieCarrier, getUsableSession);
  if (auth.response) return auth.response;
  const { session } = auth;

  const { id } = await params;
  const updates = await request.json().catch(() => null);
  if (!updates) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: cookieCarrier.headers });
  }
  if (!hasValidCardStates(updates)) {
    return NextResponse.json({ error: "Invalid flashcard." }, { status: 400, headers: cookieCarrier.headers });
  }

  const supabase = createAdminSupabaseClient();
  const dbUpdates: Record<string, unknown> = {};
  if (updates.word_id !== undefined) dbUpdates.word_id = updates.word_id;
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.source_surah_id !== undefined) dbUpdates.source_surah_id = updates.source_surah_id;
  if (updates.source_ayah_number !== undefined) dbUpdates.source_ayah_number = updates.source_ayah_number;
  if (updates.source_juz_number !== undefined) dbUpdates.source_juz_number = updates.source_juz_number;
  if (updates.source_page_number !== undefined) dbUpdates.source_page_number = updates.source_page_number;
  if (updates.fsrs_state !== undefined) dbUpdates.fsrs_state = updates.fsrs_state;
  // Classic (SM-2) state; null clears it (undo of a card's first review).
  if (updates.sm2_state !== undefined) dbUpdates.sm2_state = updates.sm2_state;

  const { error } = await supabase
    .from("user_flashcards")
    .update(dbUpdates)
    .eq("id", id)
    .eq("user_id", session.player_id);

  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not update the flashcard.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const cookieCarrier = new NextResponse();
  const auth = await flashcardSession(request, cookieCarrier, getUsableSession);
  if (auth.response) return auth.response;
  const { session } = auth;

  const { id } = await params;
  const supabase = createAdminSupabaseClient();
  const { error } = await supabase
    .from("user_flashcards")
    .delete()
    .eq("id", id)
    .eq("user_id", session.player_id);

  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not delete the flashcard.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}
