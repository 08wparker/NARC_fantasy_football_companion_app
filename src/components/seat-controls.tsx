"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  assignUserToSeatAction,
  setInviteEmailAction,
  setLeagueRoleAction,
  setSeatActiveAction,
  unlinkSeatAction,
} from "@/app/actions/managers";

export type SeatRow = {
  id: number;
  teamAbbrev: string;
  teamName: string;
  displayName: string | null;
  inviteEmail: string | null;
  isCommissioner: boolean;
  isActive: boolean;
  role: "primary" | "co";
  user: { id: number; displayName: string | null; email: string | null } | null;
};

export type UserOption = { id: number; displayName: string | null; email: string | null };

const input =
  "rounded-md border border-border bg-surface-2 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent";
const btn =
  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export function SeatControls({ seat, users }: { seat: SeatRow; users: UserOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(seat.inviteEmail ?? "");
  const [assignTo, setAssignTo] = useState<string>("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  };

  const unassigned = users.filter((u) => u.id !== seat.user?.id);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${input} w-56`}
          placeholder="invite email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => {
            const next = email.trim() || null;
            if (next === (seat.inviteEmail ?? null)) return;
            run(() => setInviteEmailAction(seat.id, next));
          }}
          disabled={pending}
        />

        {seat.user ? (
          <button
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Unlink ${seat.user?.displayName} from ${seat.teamAbbrev}?`)) return;
              run(() => unlinkSeatAction(seat.id));
            }}
            className={`${btn} border border-border text-muted hover:text-foreground hover:bg-surface-2`}
          >
            Unlink
          </button>
        ) : (
          unassigned.length > 0 && (
            <div className="flex items-center gap-1">
              <select
                className={input}
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
                disabled={pending}
              >
                <option value="">assign a signed-up user…</option>
                {unassigned.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName ?? u.email ?? `User ${u.id}`}
                  </option>
                ))}
              </select>
              <button
                disabled={pending || !assignTo}
                onClick={() => run(() => assignUserToSeatAction(seat.id, Number(assignTo)))}
                className={`${btn} border border-border text-muted hover:text-foreground hover:bg-surface-2`}
              >
                Assign
              </button>
            </div>
          )
        )}

        <button
          disabled={pending}
          onClick={() =>
            run(() =>
              setLeagueRoleAction(seat.id, seat.isCommissioner ? "member" : "commissioner"),
            )
          }
          className={
            seat.isCommissioner
              ? `${btn} border border-danger/40 text-danger hover:bg-danger/10`
              : `${btn} border border-border text-muted hover:text-foreground hover:bg-surface-2`
          }
        >
          {seat.isCommissioner ? "Remove commish" : "Make commish"}
        </button>

        {!seat.isActive && (
          <button
            disabled={pending}
            onClick={() => run(() => setSeatActiveAction(seat.id, true))}
            className={`${btn} border border-border text-muted hover:text-foreground`}
          >
            Reactivate
          </button>
        )}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
