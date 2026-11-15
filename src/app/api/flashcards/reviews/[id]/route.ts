import { NextResponse } from "next/server";
import { getUsableSession } from "@/lib/qf-user/session";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authRequiredBody } from "@/lib/flashcard/auth-required";
import { clientErrorMessage } from "@/lib/public-error";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const cookieCarrier = new NextResponse();
  const session = await getUsableSession(cookieCarrier.cookies);
  if (!session) {
    return NextResponse.json(authRequiredBody(request), { status: 401 });
  }

  const { id } = await params;
  const supabase = createAdminSupabaseClient();
  const { error } = await supabase
    .from("review_log")
    .delete()
    .eq("id", id)
    .eq("user_id", session.player_id);

  if (error) {
    return NextResponse.json({ error: clientErrorMessage(error, "Could not delete the review.") }, { status: 500, headers: cookieCarrier.headers });
  }

  return NextResponse.json({ ok: true }, { headers: cookieCarrier.headers });
}
