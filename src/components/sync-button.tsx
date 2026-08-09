"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type SyncResponse = {
  ok: boolean;
  error?: string;
  results?: Array<{
    year: number;
    result: { status: string; dormant: boolean; error?: string; counts: Record<string, number> };
  }>;
};

export function SyncButton({ years }: { years: number[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [response, setResponse] = useState<SyncResponse | null>(null);

  return (
    <div className="space-y-3">
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResponse(null);
            const res = await fetch("/api/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ years }),
            });
            setResponse((await res.json()) as SyncResponse);
            router.refresh();
          })
        }
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {pending ? "Syncing…" : `Sync ESPN (${years.join(", ")})`}
      </button>

      {response?.error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {response.error}
        </p>
      )}

      {response?.results?.map(({ year, result }) => (
        <p key={year} className="text-sm">
          <span className="font-mono tnum">{year}</span>{" "}
          {result.status === "failed" ? (
            <span className="text-danger">failed — {result.error}</span>
          ) : result.dormant ? (
            <span className="text-warning">
              dormant on ESPN; team identity synced, records left blank
            </span>
          ) : (
            <span className="text-accent">
              synced {result.counts.teams} teams, {result.counts.rosterSpots} roster spots
            </span>
          )}
        </p>
      ))}
    </div>
  );
}
