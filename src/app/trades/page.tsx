import Link from "next/link";

import { CancelButton, ConfirmRejectButtons, VoidButton } from "@/components/trade-actions";
import { Badge, Callout, Card, EmptyState, TeamChip } from "@/components/ui";
import { db } from "@/db";
import { tradeHistory } from "@/db/queries";
import { pendingForActor } from "@/db/trade-service";
import { getMembership } from "@/lib/auth/membership";
import { describeAsset, formatDate } from "@/lib/describe";
import { getLeague } from "@/lib/league";

const STATUS_TONE = {
  pending: "warning",
  confirmed: "accent",
  rejected: "neutral",
  cancelled: "neutral",
  voided: "danger",
} as const;

type AssetRow = Parameters<typeof describeAsset>[0] & {
  id: number;
  fromTeam: { abbrev: string };
  toTeam: { abbrev: string };
};

function AssetList({ assets }: { assets: AssetRow[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {assets.map((a) => (
        <li key={a.id} className="flex items-center gap-2 flex-wrap">
          <TeamChip abbrev={a.fromTeam.abbrev} />
          <span className="text-muted">→</span>
          <TeamChip abbrev={a.toTeam.abbrev} />
          <span>{describeAsset(a)}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function TradesPage() {
  const league = await getLeague();
  const membership = await getMembership();
  const canAct = membership && !membership.isUnlinked;

  const [pending, history] = await Promise.all([
    canAct
      ? pendingForActor(db, league.id, membership)
      : Promise.resolve([] as Awaited<ReturnType<typeof pendingForActor>>),
    tradeHistory(db, league.id, {
      statuses: ["confirmed", "voided", "pending", "rejected", "cancelled"],
    }),
  ]);

  const myPending = new Set(pending.map((t) => t.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
          <p className="text-muted mt-1">
            The authoritative record. ESPN cannot represent a traded pick at all.
          </p>
        </div>
        {canAct && (
          <Link
            href="/trades/new"
            className="ml-auto rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 transition-colors"
          >
            Log a trade
          </Link>
        )}
      </div>

      {membership?.isUnlinked && (
        <Callout tone="warning">
          You are signed in but not linked to a franchise, so you cannot log or confirm trades yet.
        </Callout>
      )}

      {pending.length > 0 && (
        <Card
          title="Waiting on you"
          subtitle="Nothing moves until you confirm. Check the assets carefully."
        >
          <ul className="divide-y divide-border">
            {pending.map((t) => {
              const full = history.find((h) => h.id === t.id);
              return (
                <li key={t.id} className="px-5 py-4 flex flex-wrap gap-4">
                  <div className="min-w-0 flex-1">
                    {full && <AssetList assets={full.assets as unknown as AssetRow[]} />}
                    {t.note && <p className="text-sm text-muted mt-2 italic">“{t.note}”</p>}
                  </div>
                  <ConfirmRejectButtons tradeId={t.id} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card title="All trades">
        {history.length === 0 ? (
          <EmptyState
            title="No trades logged yet."
            hint="Pick trades agreed in past seasons can be backfilled here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {history.map((t) => {
              const voidEvent = t.events.find((e) => e.action === "voided");
              const isMine =
                canAct && membership.teamIds.includes(t.loggedByTeamId);

              return (
                <li key={t.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                    <span className="text-xs text-muted tnum">
                      {t.status === "confirmed" || t.status === "voided"
                        ? formatDate(t.confirmedAt)
                        : formatDate(t.createdAt)}
                    </span>
                    <span className="text-xs text-muted">
                      logged by {t.loggedByTeam.abbrev}
                    </span>

                    <div className="ml-auto flex gap-2">
                      {t.status === "pending" && myPending.has(t.id) && (
                        <ConfirmRejectButtons tradeId={t.id} />
                      )}
                      {t.status === "pending" && isMine && <CancelButton tradeId={t.id} />}
                      {t.status === "confirmed" && membership?.isCommissioner && (
                        <VoidButton tradeId={t.id} />
                      )}
                    </div>
                  </div>

                  <div className={`mt-3 ${t.status === "voided" ? "opacity-50 line-through" : ""}`}>
                    <AssetList assets={t.assets as unknown as AssetRow[]} />
                  </div>

                  {t.note && <p className="text-sm text-muted mt-2 italic">“{t.note}”</p>}

                  {voidEvent?.note && (
                    <p className="mt-2 text-sm text-danger">Voided: {voidEvent.note}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
