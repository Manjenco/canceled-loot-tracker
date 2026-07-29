import { getCurrentSeasonId } from '../../../lib/db.js';

/**
 * The season the current request should READ from: the user's selected "view season"
 * (set via POST /api/me/active-season, stored on the session), falling back to the
 * resolved current season when nothing is selected.
 *
 * Session-less paths (WCL cron, bot import) never call this — they use getCurrentSeasonId
 * directly so new data always lands in the true current season, regardless of what any
 * officer happens to be viewing.
 */
export async function viewSeasonId(c, db) {
  const selected = c.get('session')?.user?.seasonId;
  return selected != null ? selected : await getCurrentSeasonId(db);
}
