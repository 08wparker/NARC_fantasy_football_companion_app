import { db } from "@/db";
import * as schema from "@/db/schema";
import { getMembership } from "@/lib/auth/membership";
import { inArray } from "drizzle-orm";

import { Badge } from "./ui";

/**
 * Shows which franchise the signed-in user manages, or flags that they are
 * signed in but not yet linked to one — the state every new manager lands in
 * until the commissioner assigns their seat.
 */
export async function MembershipBadge() {
  let membership;
  try {
    membership = await getMembership();
  } catch {
    // League not seeded yet; the home page explains what to do.
    return null;
  }
  if (!membership) return null;

  if (membership.isUnlinked) {
    return <Badge tone="warning">Not linked to a team</Badge>;
  }

  const teams = await db.query.teams.findMany({
    where: inArray(schema.teams.id, membership.teamIds),
  });

  return (
    <div className="flex items-center gap-1.5">
      {teams.map((t) => (
        <Badge key={t.id} tone="accent">
          {t.abbrev}
        </Badge>
      ))}
      {membership.isCommissioner && <Badge tone="info">Commish</Badge>}
    </div>
  );
}
