"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { logTradeAction } from "@/app/actions/trades";

export type BuilderTeam = { id: number; abbrev: string; name: string };
export type BuilderSeason = { id: number; year: number };
export type BuilderPick = {
  id: number;
  round: number;
  seasonId: number;
  year: number;
  ownerTeamId: number;
  originalTeamAbbrev: string;
};

type Row =
  | { key: string; kind: "draft_pick"; fromTeamId: number; toTeamId: number; draftPickId: number | "" }
  | { key: string; kind: "draft_slot_swap"; fromTeamId: number; toTeamId: number; seasonId: number | "" }
  | {
      key: string;
      kind: "keeper_slot";
      fromTeamId: number;
      toTeamId: number;
      seasonId: number | "";
      slotCount: number;
    };

let rowCounter = 0;
const newKey = () => `row-${rowCounter++}`;

const input =
  "rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent";

/**
 * Build a multi-asset trade.
 *
 * Deliberately supports mixed asset kinds in one trade and does not assume two
 * teams — three-way trades work because from/to live on each asset row rather
 * than on the trade.
 */
export function TradeBuilder({
  teams,
  seasons,
  picks,
  myTeamIds,
}: {
  teams: BuilderTeam[];
  seasons: BuilderSeason[];
  picks: BuilderPick[];
  myTeamIds: number[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const defaultFrom = myTeamIds[0] ?? teams[0]?.id ?? 0;
  const defaultTo = teams.find((t) => t.id !== defaultFrom)?.id ?? 0;

  const [loggedByTeamId, setLoggedByTeamId] = useState(defaultFrom);
  const [agreedOn, setAgreedOn] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([
    {
      key: newKey(),
      kind: "draft_pick",
      fromTeamId: defaultFrom,
      toTeamId: defaultTo,
      draftPickId: "",
    },
  ]);

  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const picksByOwner = useMemo(() => {
    const m = new Map<number, BuilderPick[]>();
    for (const p of picks) {
      const list = m.get(p.ownerTeamId) ?? [];
      list.push(p);
      m.set(p.ownerTeamId, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.year - b.year || a.round - b.round);
    }
    return m;
  }, [picks]);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? ({ ...r, ...patch } as Row) : r)));

  const addRow = (kind: Row["kind"]) =>
    setRows((rs) => [
      ...rs,
      kind === "draft_pick"
        ? { key: newKey(), kind, fromTeamId: defaultFrom, toTeamId: defaultTo, draftPickId: "" }
        : kind === "draft_slot_swap"
          ? { key: newKey(), kind, fromTeamId: defaultFrom, toTeamId: defaultTo, seasonId: "" }
          : {
              key: newKey(),
              kind,
              fromTeamId: defaultFrom,
              toTeamId: defaultTo,
              seasonId: "",
              slotCount: 1,
            },
    ]);

  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const submit = () => {
    setError(null);

    const assets = rows.map((r) => {
      if (r.kind === "draft_pick") {
        return {
          kind: "draft_pick" as const,
          fromTeamId: r.fromTeamId,
          toTeamId: r.toTeamId,
          draftPickId: Number(r.draftPickId),
        };
      }
      if (r.kind === "draft_slot_swap") {
        return {
          kind: "draft_slot_swap" as const,
          fromTeamId: r.fromTeamId,
          toTeamId: r.toTeamId,
          seasonId: Number(r.seasonId),
        };
      }
      return {
        kind: "keeper_slot" as const,
        fromTeamId: r.fromTeamId,
        toTeamId: r.toTeamId,
        seasonId: Number(r.seasonId),
        slotCount: r.slotCount,
      };
    });

    const incomplete = assets.some(
      (a) =>
        ("draftPickId" in a && !a.draftPickId) ||
        ("seasonId" in a && !a.seasonId) ||
        !a.fromTeamId ||
        !a.toTeamId,
    );
    if (incomplete) {
      setError("Every row needs both teams and an asset selected.");
      return;
    }

    start(async () => {
      const result = await logTradeAction({
        loggedByTeamId,
        assets,
        agreedOn: agreedOn || null,
        note: note || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/trades");
      router.refresh();
    });
  };

  const TeamSelect = ({
    value,
    onChange,
    label,
  }: {
    value: number;
    onChange: (v: number) => void;
    label: string;
  }) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <select className={input} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.abbrev}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Logging as</span>
          <select
            className={input}
            value={loggedByTeamId}
            onChange={(e) => setLoggedByTeamId(Number(e.target.value))}
          >
            {teams
              .filter((t) => myTeamIds.length === 0 || myTeamIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.abbrev} — {t.name}
                </option>
              ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Agreed on (optional)</span>
          <input
            type="date"
            className={input}
            value={agreedOn}
            onChange={(e) => setAgreedOn(e.target.value)}
          />
        </label>
      </div>

      <div className="space-y-3">
        {rows.map((r) => {
          const available = picksByOwner.get(r.fromTeamId) ?? [];
          return (
            <div key={r.key} className="rounded-lg border border-border bg-surface-2/50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  {r.kind.replace(/_/g, " ")}
                </span>
                {rows.length > 1 && (
                  <button
                    onClick={() => removeRow(r.key)}
                    className="ml-auto text-xs text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <TeamSelect
                  label={r.kind === "draft_slot_swap" ? "Team A" : "From"}
                  value={r.fromTeamId}
                  onChange={(v) => update(r.key, { fromTeamId: v })}
                />
                <TeamSelect
                  label={r.kind === "draft_slot_swap" ? "Team B" : "To"}
                  value={r.toTeamId}
                  onChange={(v) => update(r.key, { toTeamId: v })}
                />

                {r.kind === "draft_pick" && (
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-xs text-muted">
                      Pick ({teamById.get(r.fromTeamId)?.abbrev} currently owns {available.length})
                    </span>
                    <select
                      className={input}
                      value={r.draftPickId}
                      onChange={(e) => update(r.key, { draftPickId: Number(e.target.value) })}
                    >
                      <option value="">Select a pick…</option>
                      {available.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.year} round {p.round}
                          {p.originalTeamAbbrev !== teamById.get(r.fromTeamId)?.abbrev
                            ? ` (via ${p.originalTeamAbbrev})`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {(r.kind === "draft_slot_swap" || r.kind === "keeper_slot") && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted">Season</span>
                    <select
                      className={input}
                      value={r.seasonId}
                      onChange={(e) => update(r.key, { seasonId: Number(e.target.value) })}
                    >
                      <option value="">Select…</option>
                      {seasons.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.year}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {r.kind === "keeper_slot" && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted">Slots</span>
                    <input
                      type="number"
                      min={1}
                      className={input}
                      value={r.slotCount}
                      onChange={(e) => update(r.key, { slotCount: Number(e.target.value) })}
                    />
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        {(["draft_pick", "draft_slot_swap", "keeper_slot"] as const).map((kind) => (
          <button
            key={kind}
            onClick={() => addRow(kind)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            + {kind.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Note (optional)</span>
        <textarea
          className={`${input} min-h-20`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the other side should confirm they agreed to."
        />
      </label>

      {error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {pending ? "Logging…" : "Log trade"}
        </button>
        <p className="text-xs text-muted">
          This creates a pending trade. Nothing moves until the other side confirms.
        </p>
      </div>
    </div>
  );
}
