"use client";

import { useState, useCallback } from "react";
import type { VerseAudioFile, VerseAudioFilesResponse } from "@/lib/types";

// Module-level cache: avoids re-fetching when user toggles reciters
const cache = new Map<string, { files: VerseAudioFile[]; expires: number }>();

export function useVerseAudioFiles() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAudioFiles = useCallback(
    async (reciterId: number, chapterNumber: number): Promise<VerseAudioFile[]> => {
      const key = `${reciterId}-${chapterNumber}`;
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.files;
      cache.delete(key);

      setIsLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/quran/verse-recitation/${reciterId}/${chapterNumber}`
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Failed to load verse audio.");
        }
        const data = (await res.json()) as VerseAudioFilesResponse;
        cache.set(key, { files: data.audio_files, expires: Date.now() + 3600000 });
        return data.audio_files;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load verse audio.";
        setError(msg);
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return { fetchAudioFiles, isLoading, error };
}
