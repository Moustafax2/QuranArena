import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { flashcardSession } from "@/lib/flashcard/auth-required";

export async function DELETE(request: Request) {
  const cookieCarrier = new NextResponse();
  const auth = await flashcardSession(request, cookieCarrier, getUsableSession);
  if (auth.response) return auth.response;
  const { session } = auth;

  const supabase = createAdminSupabaseClient();
  const userId = session.player_id;

  // Review log first (it references the cards), then cards, then preferences.
  // Stop at the first failure so the client is told the reset did not finish.
  for (const table of ["review_log", "user_flashcards", "user_preferences"] as const) {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) {
      console.error(`Flashcard reset failed on ${table}:`, error.message);
      return NextResponse.json(
        { error: "Could not reset all flashcard data. Please try again." },
        { status: 500, headers: cookieCarrier.headers }
      );
    }
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}
