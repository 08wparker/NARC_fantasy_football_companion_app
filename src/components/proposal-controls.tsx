"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  castVoteAction,
  closeVotingAction,
  createProposalAction,
  openVotingAction,
  withdrawProposalAction,
} from "@/app/actions/proposals";

const input =
  "rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-full";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      after?.();
      router.refresh();
    });
  };

  return { pending, error, run };
}

export function NewProposalForm() {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 transition-colors"
      >
        Propose a rule change
      </button>
    );
  }

  return (
    <div className="w-full space-y-3">
      <input
        className={input}
        placeholder="Rule change title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={`${input} min-h-28`}
        placeholder="What exactly changes, and why?"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() =>
            run(() => createProposalAction({ title, body }), () => {
              setTitle("");
              setBody("");
              setOpen(false);
            })
          }
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Submit draft"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-muted">
        Drafts are not votable until the commissioner opens the ballot.
      </p>
    </div>
  );
}

export function VoteButtons({
  proposalId,
  teamId,
  current,
}: {
  proposalId: number;
  teamId: number;
  current?: "yes" | "no" | "abstain";
}) {
  const { pending, error, run } = useAction();
  const choices = ["yes", "no", "abstain"] as const;

  return (
    <div>
      <div className="flex gap-1.5">
        {choices.map((choice) => {
          const active = current === choice;
          return (
            <button
              key={choice}
              disabled={pending}
              onClick={() => run(() => castVoteAction(proposalId, teamId, choice))}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:opacity-50 ${
                active
                  ? choice === "yes"
                    ? "bg-accent text-background"
                    : choice === "no"
                      ? "bg-danger text-background"
                      : "bg-surface-2 text-foreground border border-border"
                  : "border border-border text-muted hover:text-foreground hover:bg-surface-2"
              }`}
            >
              {choice}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function OpenVotingButton({ proposalId }: { proposalId: number }) {
  const { pending, error, run } = useAction();
  const [days, setDays] = useState(7);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted">
        Close in
        <input
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="ml-2 w-16 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-foreground"
        />
        <span className="ml-1">days</span>
      </label>
      <button
        disabled={pending}
        onClick={() => {
          const closesAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          run(() => openVotingAction(proposalId, closesAt.toISOString()));
        }}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50"
      >
        Open ballot
      </button>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  );
}

export function CloseVotingButton({ proposalId }: { proposalId: number }) {
  const { pending, error, run } = useAction();
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Close the ballot and freeze the result?")) return;
          run(() => closeVotingAction(proposalId));
        }}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground hover:bg-surface-2 disabled:opacity-50"
      >
        Close ballot
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function WithdrawButton({ proposalId }: { proposalId: number }) {
  const { pending, error, run } = useAction();
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Withdraw this proposal?")) return;
          run(() => withdrawProposalAction(proposalId));
        }}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger disabled:opacity-50"
      >
        Withdraw
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
