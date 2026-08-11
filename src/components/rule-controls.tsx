"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  addRuleAction,
  deleteRuleAction,
  moveRuleAction,
  updateRuleAction,
} from "@/app/actions/rules";

const input =
  "w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent";
const btn =
  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong.");
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

export function AddRuleForm() {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
      >
        Add a rule
      </button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <textarea
        className={`${input} min-h-20`}
        placeholder="e.g. Waivers run Wednesday at 3am."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={pending || !body.trim()}
          onClick={() =>
            run(() => addRuleAction(body), () => {
              setBody("");
              setOpen(false);
            })
          }
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add rule"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function RuleRow({
  rule,
  index,
  total,
}: {
  rule: { id: number; body: string };
  index: number;
  total: number;
}) {
  const { pending, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(rule.body);

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          className={`${input} min-h-20`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <button
            disabled={pending || !body.trim()}
            onClick={() => run(() => updateRuleAction(rule.id, body), () => setEditing(false))}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => {
              setBody(rule.body);
              setEditing(false);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <p className="flex-1 text-sm">{rule.body}</p>
      <div className="flex shrink-0 gap-1">
        <button
          disabled={pending || index === 0}
          onClick={() => run(() => moveRuleAction(rule.id, "up"))}
          className={`${btn} border border-border text-muted hover:text-foreground`}
          aria-label="Move rule up"
        >
          ↑
        </button>
        <button
          disabled={pending || index === total - 1}
          onClick={() => run(() => moveRuleAction(rule.id, "down"))}
          className={`${btn} border border-border text-muted hover:text-foreground`}
          aria-label="Move rule down"
        >
          ↓
        </button>
        <button
          disabled={pending}
          onClick={() => setEditing(true)}
          className={`${btn} border border-border text-muted hover:text-foreground`}
        >
          Edit
        </button>
        <button
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Delete this rule?")) return;
            run(() => deleteRuleAction(rule.id));
          }}
          className={`${btn} border border-danger/40 text-danger hover:bg-danger/10`}
        >
          Delete
        </button>
      </div>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  );
}
