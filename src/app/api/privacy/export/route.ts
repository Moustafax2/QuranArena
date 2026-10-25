import { NextResponse } from "next/server";
import { privacyIdentity } from "@/lib/privacy/account";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export async function GET() {
  try {
    const identity = await privacyIdentity();
    if (!identity) return NextResponse.json({ error: "Sign in or restore your guest session to export server records." }, { status: 401 });
    const { data, error } = await createAdminSupabaseClient().rpc("export_player_data", { target_player: identity.playerId });
    if (error) throw error;
    return NextResponse.json({ exportedAt: new Date().toISOString(), appRecords: data,
      note: "QF-hosted bookmarks are managed through Quran.com. This file does not contain OAuth tokens." },
    { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="quranarena-data.json"' } });
  } catch {
    return NextResponse.json({ error: "Export is unavailable. Please retry or contact support." }, { status: 503 });
  }
}
