import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

interface MuyassarRawEntry {
  text: string;
}

export interface MuyassarParsedEntry {
  quranicWord: string;
  explanation: string;
  isSingleWord: boolean;
}

let cachedDB: Record<string, MuyassarRawEntry> | null = null;

function getDB(): Record<string, MuyassarRawEntry> {
  if (cachedDB) return cachedDB;
  const filePath = path.join(
    process.cwd(),
    "data",
    "al-muyassar-fi-al-gharib.json"
  );
  const raw = fs.readFileSync(filePath, "utf-8");
  cachedDB = JSON.parse(raw);
  return cachedDB!;
}

// Parse HTML like:
// <p><span class="qpc-hafs">﴿word﴾</span>: explanation.</p>
function parseEntries(html: string): MuyassarParsedEntry[] {
  const results: MuyassarParsedEntry[] = [];
  // Match each span + following colon + explanation
  const spanRegex = /﴿([^﴾]+)﴾<\/span>\s*:\s*([\s\S]*?)(?=<\/p>|<p>|$)/g;
  let match: RegExpExecArray | null;
  while ((match = spanRegex.exec(html)) !== null) {
    const quranicWord = match[1].trim();
    // Strip any HTML tags from explanation
    const explanation = match[2].replace(/<[^>]+>/g, "").trim();
    if (!quranicWord || !explanation) continue;
    const isSingleWord = !quranicWord.includes(" ");
    results.push({ quranicWord, explanation, isSingleWord });
  }
  return results;
}

function entriesFor(db: Record<string, MuyassarRawEntry>, key: string): MuyassarParsedEntry[] {
  const entry = db[key];
  return entry?.text ? parseEntries(entry.text) : [];
}

// A flashcard checks up to this many example verses for a Muyassar entry.
const MAX_BATCH = 8;
const VERSE_KEY = /^\d{1,3}:\d{1,3}$/;

export async function GET(request: NextRequest) {
  // ?verses=2:5,3:7 answers several verses in one request (audit L18: a card
  // used to make up to 8 requests one after another).
  const verses = request.nextUrl.searchParams.get("verses");
  if (verses !== null) {
    const keys = verses.split(",");
    if (keys.length > MAX_BATCH || !keys.every((key) => VERSE_KEY.test(key))) {
      return NextResponse.json({ error: `verses must be up to ${MAX_BATCH} surah:ayah keys` }, { status: 400 });
    }
    try {
      const db = getDB();
      return NextResponse.json({ results: Object.fromEntries(keys.map((key) => [key, entriesFor(db, key)])) });
    } catch (err) {
      console.error("Muyassar lookup error:", err);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  }

  const surah = request.nextUrl.searchParams.get("surah");
  const ayah = request.nextUrl.searchParams.get("ayah");

  if (!surah || !ayah) {
    return NextResponse.json({ error: "surah and ayah params required" }, { status: 400 });
  }

  try {
    const db = getDB();
    const key = `${surah}:${ayah}`;
    const entry = db[key];

    if (!entry || !entry.text) {
      return NextResponse.json({ entries: [] });
    }

    const entries = parseEntries(entry.text);
    return NextResponse.json({ entries });
  } catch (err) {
    console.error("Muyassar lookup error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
