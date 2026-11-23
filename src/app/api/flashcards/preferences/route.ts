import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { flashcardSession } from "@/lib/flashcard/auth-required";
import { clientErrorMessage } from "@/lib/public-error";

export async function GET(request: Request) {
  const cookieCarrier = new NextResponse();
  const auth = await flashcardSession(request, cookieCarrier, getUsableSession);
  if (auth.response) return auth.response;
  const { session } = auth;

  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", session.player_id)
    .single();

  if (error || !data) {
    return NextResponse.json(null, { headers: cookieCarrier.headers });
  }

  return NextResponse.json(data, { headers: cookieCarrier.headers });
}

export async function PUT(request: Request) {
  const cookieCarrier = new NextResponse();
  const auth = await flashcardSession(request, cookieCarrier, getUsableSession);
  if (auth.response) return auth.response;
  const { session } = auth;

  const prefs = await request.json().catch(() => null);
  if (!prefs) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: cookieCarrier.headers });
  }

  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from("user_preferences").upsert(
    {
      user_id: session.player_id,
      show_arabic_explanation: prefs.show_arabic_explanation,
      show_root: prefs.show_root,
      show_ayah_examples: prefs.show_ayah_examples,
      include_particles: prefs.include_particles,
      include_proper_nouns: prefs.include_proper_nouns,
      auto_audio: prefs.auto_audio,
      show_transliteration: prefs.show_transliteration,
      daily_new_cards_limit: prefs.daily_new_cards_limit,
      daily_review_cards_limit: prefs.daily_review_cards_limit,
      session_size: prefs.session_size,
      normalization_level: prefs.normalization_level,
      // Older clients don't send these; leave the stored values alone then.
      ...(typeof prefs.new_cards_ignore_review_limit === "boolean"
        ? { new_cards_ignore_review_limit: prefs.new_cards_ignore_review_limit }
        : {}),
      ...(prefs.algorithm === "fsrs" || prefs.algorithm === "sm2" ? { algorithm: prefs.algorithm } : {}),
      ...(prefs.fsrs_params && typeof prefs.fsrs_params === "object" ? { fsrs_params: prefs.fsrs_params } : {}),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not save preferences.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}
