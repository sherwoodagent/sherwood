"use client";
import ErrorDisplay from "@/components/ErrorDisplay";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorDisplay error={error} reset={reset} />;
}
