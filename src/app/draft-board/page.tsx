import Link from "next/link";

import { Badge, Callout, Card, EmptyState, TeamChip, pickLabel } from "@/components/ui";
import { db } from "@/db";
import { draftBoard, seasonsForLeague } from "@/db/queries";
import { getLeague } from "@/lib/league";

export default async function DraftBoardPage(props: PageProps<"/draft-board">) {
  // Next 16: searchParams is a Promise.
  const searchParams = await props.searchParams;
  const league = await getLeague();
  const seasons = await seasonsForLeague(db, league.id);

  if (seasons.length === 0) {
    return <Callout tone="warning">No seasons scaffolded yet. Run the seed script.</Callout>;
  }

  const requestedYear = Number(searchParams.year);
  const season =
    seasons.find((s) => s.year === requestedYear) ??
    seasons.find((s) => s.year > new Date().getUTCFullYear()) ??
    seasons[0];

  const board = await draftBoard(db, season.id);
  const rounds = [...new Set(board.map((p) => p.round))].sort((a, b) => a - b);
  const tradedCount = board.filter((p) => p.isTraded).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Draft board</h1>
          <p className="text-muted mt-1">
            {season.isSnakeDraft ? "Snake order" : "Straight order"} · {tradedCount} of{" "}
            {board.length} picks have changed hands
          </p>
        </div>

        <nav className="ml-auto flex gap-1">
          {seasons.map((s) => (
            <Link
              key={s.id}
              href={`/draft-board?year=${s.year}`}
              className={`rounded-md px-3 py-1.5 text-sm tnum transition-colors ${
                s.id === season.id
                  ? "bg-accent text-background font-medium"
                  : "text-muted hover:text-foreground hover:bg-surface-2"
              }`}
            >
              {s.year}
            </Link>
          ))}
        </nav>
      </div>

      {board.length === 0 ? (
        <EmptyState title="No picks scaffolded for this season." />
      ) : (
        <div className="space-y-4">
          {rounds.map((round) => (
            <Card key={round} title={`Round ${round}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                      <th className="px-5 py-2 font-medium">Pick</th>
                      <th className="px-3 py-2 font-medium">Overall</th>
                      <th className="px-3 py-2 font-medium">Owner</th>
                      <th className="px-3 py-2 font-medium">Original</th>
                      <th className="px-5 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {board
                      .filter((p) => p.round === round)
                      .map((p) => (
                        <tr
                          key={p.pickId}
                          className={`border-b border-border/50 last:border-0 ${
                            p.isTraded ? "bg-accent/5" : ""
                          }`}
                        >
                          <td className="px-5 py-2 font-mono tnum">
                            {pickLabel(p.round, p.pickInRound)}
                          </td>
                          <td className="px-3 py-2 tnum text-muted">{p.overall}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium">{p.currentOwner.abbrev}</span>
                            <span className="text-muted ml-2 hidden sm:inline">
                              {p.currentOwner.name}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {p.isTraded ? (
                              <TeamChip abbrev={p.originalTeam.abbrev} />
                            ) : (
                              <span className="text-muted/50">own</span>
                            )}
                          </td>
                          <td className="px-5 py-2 text-right">
                            {p.isTraded && <Badge tone="accent">Traded</Badge>}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted">
        A pick keeps its original team&apos;s board position even after it is traded. A slot swap
        moves a franchise&apos;s whole set of picks; a pick trade moves one pick&apos;s owner.
      </p>
    </div>
  );
}
