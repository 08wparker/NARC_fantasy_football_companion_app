type AssetLike = {
  kind: string;
  slotCount: number | null;
  fromTeam?: { abbrev: string } | null;
  toTeam?: { abbrev: string } | null;
  season?: { year: number } | null;
  player?: { fullName: string } | null;
  draftPick?: {
    round: number;
    season?: { year: number } | null;
    originalTeam?: { abbrev: string } | null;
  } | null;
};

/**
 * One line describing what moved, in the language the league uses:
 * "WFP's 2027 3rd", not "draft_pick #412".
 */
export function describeAsset(a: AssetLike): string {
  switch (a.kind) {
    case "draft_pick": {
      const year = a.draftPick?.season?.year ?? "?";
      const round = a.draftPick?.round ?? "?";
      const origin = a.draftPick?.originalTeam?.abbrev;
      return `${origin ? `${origin}'s ` : ""}${year} ${ordinal(Number(round))}`;
    }
    case "player":
      return a.player?.fullName ?? "a player";
    case "keeper_right":
      return `${a.season?.year ?? "?"} keeper rights to ${a.player?.fullName ?? "a player"}`;
    case "keeper_slot": {
      const n = a.slotCount ?? 1;
      return `${n} ${a.season?.year ?? "?"} keeper slot${n === 1 ? "" : "s"}`;
    }
    case "draft_slot_swap":
      return `${a.season?.year ?? "?"} draft slot swap`;
    default:
      return a.kind;
  }
}

export function ordinal(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}
