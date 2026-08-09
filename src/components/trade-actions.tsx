"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  cancelTradeAction,
  confirmTradeAction,
  rejectTradeAction,
  voidTradeAction,
} from "@/app/actions/trades";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; warnings?: string[] }>) => {
    setError(null);
    setWarnings([]);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      if (result.warnings?.length) setWarnings(result.warnings);
      router.refresh();
    });
  };

  return { pending, error, warnings, run };
}

function Feedback({ error, warnings }: { error: string | null; warnings: string[] }) {
  if (!error && warnings.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-xs">
      {error && <p className="text-danger">{error}</p>}
      {warnings.map((w) => (
        <p key={w} className="text-warning">
          ⚠ {w}
        </p>
      ))}
    </div>
  );
}

const btn =
  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export function ConfirmRejectButtons({ tradeId }: { tradeId: number }) {
  const { pending, error, warnings, run } = useAction();

  return (
    <div>
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() => run(() => confirmTradeAction(tradeId))}
          className={`${btn} bg-accent text-background hover:bg-accent/90`}
        >
          Confirm
        </button>
        <button
          disabled={pending}
          onClick={() => {
            const note = window.prompt("Reason for rejecting (optional)") ?? undefined;
            run(() => rejectTradeAction(tradeId, note));
          }}
          className={`${btn} border border-border text-muted hover:text-foreground hover:bg-surface-2`}
        >
          Reject
        </button>
      </div>
      <Feedback error={error} warnings={warnings} />
    </div>
  );
}

export function CancelButton({ tradeId }: { tradeId: number }) {
  const { pending, error, warnings, run } = useAction();
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Withdraw this proposed trade?")) return;
          run(() => cancelTradeAction(tradeId));
        }}
        className={`${btn} border border-border text-muted hover:text-foreground hover:bg-surface-2`}
      >
        Withdraw
      </button>
      <Feedback error={error} warnings={warnings} />
    </div>
  );
}

export function VoidButton({ tradeId }: { tradeId: number }) {
  const { pending, error, warnings, run } = useAction();
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          const reason = window.prompt(
            "Voiding is permanent and stays on the record. Why is this trade being voided?",
          );
          if (!reason?.trim()) return;
          run(() => voidTradeAction(tradeId, reason));
        }}
        className={`${btn} border border-danger/40 text-danger hover:bg-danger/10`}
      >
        Void
      </button>
      <Feedback error={error} warnings={warnings} />
    </div>
  );
}
