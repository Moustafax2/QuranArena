// Quran Foundation translation text marks footnotes inline, for example
// "conscious of Allāh<sup foot_note=195936>1</sup>". QuranArena does not load
// footnote bodies, so the bare marker reads as part of the word ("Allāh1").
const FOOTNOTE_MARKER = /<sup\b[^>]*\bfoot_note\b[^>]*>[\s\S]*?<\/sup>/gi;

export function stripTranslationFootnotes(text: string): string {
  return text.replace(FOOTNOTE_MARKER, "");
}

export function translationToPlainText(text: string): string {
  return stripTranslationFootnotes(text).replace(/<[^>]*>/g, "");
}
