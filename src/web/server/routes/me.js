/**
 * me.js — /api/me
 *
 * GET  /api/me
 *   Returns the current session user (safe subset — no access token).
 *
 * POST /api/me/active-char
 *   Body: { charName }
 *   Switches the active character within the current team.
 *
 * POST /api/me/active-team
 *   Body: { teamName }
 *   Switches the active team. Updates all active team/char session fields.
 *   Officer status is pre-computed per team at login — no re-fetch needed.
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import { getSeasons, getCurrentSeasonId } from '../../../lib/db.js';

const router = new Hono();

router.get('/', async (c) => {
  const session = c.get('session');
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401);

  const {
    id, username, avatar,
    teamName, charId, charName, spec, role, status, isOfficer, isGlobalOfficer,
    chars, teams,
  } = session.user;

  // Season selection — fetched live so newly-created seasons appear without re-login.
  // The effective "view season" is the user's selection if it still exists, else current.
  let seasons = [], seasonId = null, seasonName = null;
  try {
    seasons = await getSeasons(c.env.DB);
    const currentId = await getCurrentSeasonId(c.env.DB).catch(() => null);
    const selected  = session.user.seasonId;
    seasonId   = seasons.some(s => s.id === selected) ? selected : currentId;
    seasonName = seasons.find(s => s.id === seasonId)?.name ?? null;
  } catch { /* seasons are optional; a fresh DB may have none configured */ }

  return c.json({
    id, username, avatar, teamName, charId, charName, spec, role, status,
    isOfficer, isGlobalOfficer: isGlobalOfficer ?? false, chars: chars ?? [], teams: teams ?? [],
    seasonId, seasonName,
    seasons: seasons.map(s => ({ id: s.id, name: s.name })),
  });
});

router.post('/active-char', requireAuth, async (c) => {
  const { charName } = await c.req.json();
  if (!charName) return c.json({ error: 'charName is required' }, 400);

  const session     = c.get('session');
  const { chars = [] } = session.user;
  const target = chars.find(ch => ch.charName.toLowerCase() === charName.toLowerCase());
  if (!target) return c.json({ error: 'Character not found on this account' }, 400);

  session.user.charId   = target.charId;
  session.user.charName = target.charName;
  session.user.spec     = target.spec;
  session.user.role     = target.role;
  session.user.status   = target.status;

  return c.json({ ok: true, charId: target.charId, charName: target.charName, spec: target.spec });
});

router.post('/active-team', requireAuth, async (c) => {
  const { teamName } = await c.req.json();
  if (!teamName) return c.json({ error: 'teamName is required' }, 400);

  const session      = c.get('session');
  const { teams = [] } = session.user;
  const target = teams.find(t => t.teamName === teamName);
  if (!target) return c.json({ error: 'Team not found for this account' }, 400);

  const activeChar = target.chars[0] ?? null;

  session.user.teamName  = target.teamName;
  session.user.teamId    = target.teamId;
  session.user.isOfficer = target.isOfficer;
  session.user.chars       = target.chars;
  session.user.charId      = activeChar?.charId   ?? null;
  session.user.charName    = activeChar?.charName ?? null;
  session.user.spec        = activeChar?.spec     ?? null;
  session.user.role        = activeChar?.role     ?? null;
  session.user.status      = activeChar?.status   ?? null;

  return c.json({ ok: true, teamName: target.teamName });
});

// Switch the "view season" (which season's data every page shows). Pass a valid
// seasonId, or null to revert to following the current season. Session-only — it
// never changes where new data is written (cron/bot always target the current season).
router.post('/active-season', requireAuth, async (c) => {
  const { seasonId } = await c.req.json().catch(() => ({}));
  const session = c.get('session');

  if (seasonId == null) {
    session.user.seasonId = null; // follow current
    return c.json({ ok: true, seasonId: null });
  }
  const target = (await getSeasons(c.env.DB)).find(s => s.id === Number(seasonId));
  if (!target) return c.json({ error: 'Season not found' }, 400);

  session.user.seasonId = target.id;
  return c.json({ ok: true, seasonId: target.id, seasonName: target.name });
});

export default router;
