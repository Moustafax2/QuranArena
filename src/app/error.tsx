"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-gray-950 px-4 text-center text-white">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 text-red-400">
        <AlertTriangle aria-hidden="true" className="h-7 w-7" />
      </div>
      <h1 className="mt-4 text-3xl font-bold">Something went wrong</h1>
      <p className="mt-3 max-w-md text-gray-400">
        An unexpected error occurred. Please try again.
      </p>
      <div className="mt-8 flex gap-3">
        <Button variant="secondary" href="/">
          Back to home
        </Button>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
