"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { refreshRostersAction, type RefreshRostersResult } from "@/app/actions/rosters";

/**
 * Pull rosters from ESPN, then re-render the page.
 *
 * router.refresh() after the action because the roster list is server-rendered
 * from the database the action just wrote to.
 */
export function RosterRefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<RefreshRostersResult | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm">
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(null);
            setResult(await refreshRostersAction());
            router.refresh();
          })
        }
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {pending ? "Refreshing…" : "Refresh from ESPN"}
      </button>

      {result &&
        (result.ok ? (
          <span className="text-accent">
            {result.rosterSpots > 0
              ? `${result.year}: ${result.rosterSpots} roster spots across ${result.teams} teams`
              : `${result.year} has no rosters at ESPN yet`}
          </span>
        ) : (
          <span className="text-danger">{result.error}</span>
        ))}
    </div>
  );
}
