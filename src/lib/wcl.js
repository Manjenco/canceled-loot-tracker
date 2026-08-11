/**
 * wcl.js — Warcraft Logs v2 GraphQL API client.
 *
 * Handles OAuth client credentials and all GQL queries needed by the WCL sync.
 * No Sheets access here — pure WCL API calls.
 *
 * All exported functions accept (clientId, clientSecret) so the caller
 * (wcl-sync.js) passes credentials from Global Config rather than reading env
 * directly.
 */

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL   = 'https://www.warcraftlogs.com/api/v2/client';

// ── OAuth token (module-level cache — survives within one Worker invocation) ──

let _wclToken       = null;
let _wclTokenExpiry = 0;

async function getToken(clientId, clientSecret) {
  if (_wclToken && Date.now() < _wclTokenExpiry) return _wclToken;

  const resp = await fetch(WCL_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    throw new Error(`WCL OAuth failed: ${resp.status} ${await resp.text()}`);
  }

  const { access_token, expires_in } = await resp.json();
  _wclToken       = access_token;
  _wclTokenExpiry = Date.now() + (expires_in - 60) * 1000; // 60 s buffer
  return _wclToken;
}

// ── GraphQL helper ─────────────────────────────────────────────────────────────

async function gql(query, variables, clientId, clientSecret) {
  const token = await getToken(clientId, clientSecret);
  const resp  = await fetch(WCL_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    throw new Error(`WCL API error: ${resp.status} ${await resp.text()}`);
  }

  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(`WCL GQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── Queries ────────────────────────────────────────────────────────────────────

const Q_REPORTS = `
  query GetReports($guildId: Int!, $startTime: Float, $page: Int) {
    reportData {
      reports(guildID: $guildId, startTime: $startTime, limit: 25, page: $page) {
        last_page
        data {
          code
          title
          startTime
          endTime
          zone { id name }
        }
      }
    }
  }
`;

const Q_REPORT_FIGHTS = `
  query GetReportFights($code: String!) {
    reportData {
      report(code: $code) {
        startTime
        endTime
        fights(killType: All) {
          id
          encounterID
          name
          kill
          startTime
          endTime
          bossPercentage
          difficulty
          inProgress
        }
        masterData {
          actors(type: "Player") {
            id
            name
            server
            subType
          }
        }
      }
    }
  }
`;

const Q_COMBATANT_INFO = `
  query GetCombatantInfo($code: String!, $fightIds: [Int]!) {
    reportData {
      report(code: $code) {
        events(dataType: CombatantInfo, fightIDs: $fightIds) {
          data
        }
      }
    }
  }
`;

const Q_ENCOUNTER_ZONE = `
  query GetEncounterZone($encounterId: Int!) {
    worldData {
      encounter(id: $encounterId) {
        id
        name
        zone {
          id
          name
        }
      }
    }
  }
`;

const Q_ZONE_ENCOUNTERS = `
  query GetZoneEncounters($zoneId: Int!) {
    worldData {
      zone(id: $zoneId) {
        id
        name
        encounters {
          id
          name
        }
      }
    }
  }
`;

// ── Exported API ───────────────────────────────────────────────────────────────

/**
 * Look up which zone a single encounter belongs to.
 * Used by the test script to auto-detect the correct wcl_zone_ids value.
 *
 * @param {number} encounterId
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {{ encounterId, encounterName, zoneId, zoneName } | null}
 */
export async function getEncounterZone(encounterId, clientId, clientSecret) {
  const data = await gql(Q_ENCOUNTER_ZONE, { encounterId }, clientId, clientSecret);
  const enc  = data.worldData?.encounter;
  if (!enc) return null;
  return {
    encounterId:   enc.id,
    encounterName: enc.name,
    zoneId:        enc.zone?.id,
    zoneName:      enc.zone?.name,
  };
}

const Q_EXPANSIONS = `
  query { worldData { expansions { id name } } }
`;

const Q_EXPANSION_ZONES = `
  query GetExpansionZones($expansionId: Int!) {
    worldData {
      zones(expansion_id: $expansionId) {
        id
        name
        frozen
        encounters { id name }
      }
    }
  }
`;

/**
 * List the current retail expansion's raid zones (for the season zone-ID picker).
 * "Current" = the highest expansion id. Mythic+ / Delves zones are filtered out so only
 * raid tiers remain. Returns each zone's id, name, frozen flag, and its boss names — the
 * caller name-matches boss/zone names against the season's raid to pre-select the right one.
 *
 * @returns {{ expansion: {id, name}, zones: Array<{id, name, frozen, encounters: string[]}> }}
 */
export async function listRaidZones(clientId, clientSecret) {
  const exp = await gql(Q_EXPANSIONS, {}, clientId, clientSecret);
  const expansions = exp.worldData?.expansions ?? [];
  if (!expansions.length) return { expansion: null, zones: [] };
  const current = expansions.reduce((a, b) => (b.id > a.id ? b : a));

  const zdata = await gql(Q_EXPANSION_ZONES, { expansionId: current.id }, clientId, clientSecret);
  const zones = (zdata.worldData?.zones ?? [])
    .filter(z => {
      const n = String(z.name ?? '').toLowerCase();
      return !n.startsWith('mythic+') && !n.startsWith('mythic +') && !n.startsWith('delves');
    })
    .map(z => ({
      id:         z.id,
      name:       z.name,
      frozen:     !!z.frozen,
      encounters: (z.encounters ?? []).map(e => e.name).filter(Boolean),
    }));
  return { expansion: { id: current.id, name: current.name }, zones };
}

/**
 * Best-effort guess of which listed zone is the season's raid, by name-matching the season's
 * raid instance name(s) and boss name(s) against each zone's name and encounters. Pure — no
 * network. Returns null when nothing overlaps (expected before a tier goes live on WCL, when
 * only PTR/beta placeholder zones exist). The officer always confirms the pick.
 *
 * @param {Array<{id,name,frozen,encounters:string[]}>} zones  from listRaidZones
 * @param {{ raidInstanceNames?: string[], raidBossNames?: string[] }} hints
 * @returns {{ zoneId, zoneName, score, bossHits } | null}
 */
export function guessRaidZone(zones, { raidInstanceNames = [], raidBossNames = [] } = {}) {
  const norm = s => String(s ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const instSet = new Set(raidInstanceNames.map(norm).filter(Boolean));
  const bossSet = new Set(raidBossNames.map(norm).filter(Boolean));
  let best = null;
  for (const z of zones ?? []) {
    const zn = norm(z.name);
    let score = 0;
    if (instSet.has(zn)) score += 100;                                  // zone name IS the raid
    for (const inst of instSet) if (inst && zn && (zn.includes(inst) || inst.includes(zn))) score += 20;
    const bossHits = (z.encounters ?? []).map(norm).filter(e => bossSet.has(e)).length;
    score += bossHits * 10;                                             // shared bosses
    if (!z.frozen) score += 1;                                          // tie-break toward the active tier
    if (score > 1 && (!best || score > best.score)) best = { zone: z, score, bossHits };
  }
  if (!best) return null;
  return { zoneId: String(best.zone.id), zoneName: best.zone.name, score: best.score, bossHits: best.bossHits };
}

/**
 * Build a Set of valid WCL encounter IDs for the given zone IDs.
 * Called once per sync run; results used to filter out dirty-log fights.
 *
 * @param {number[]} zoneIds
 * @param {string}   clientId
 * @param {string}   clientSecret
 * @returns {Set<number>}
 */
export async function getValidEncounterIds(zoneIds, clientId, clientSecret) {
  const ids = new Set();
  for (const zoneId of zoneIds) {
    const data = await gql(Q_ZONE_ENCOUNTERS, { zoneId }, clientId, clientSecret);
    for (const enc of data.worldData?.zone?.encounters ?? []) {
      ids.add(enc.id);
    }
  }
  return ids;
}

/**
 * Fetch reports for a WCL guild created/updated on or after `sinceMs`.
 *
 * @param {number} guildId      WCL guild ID (numeric)
 * @param {number} sinceMs      Unix timestamp in milliseconds
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {object[]}  Array of report summary objects
 */
export async function getReportsForGuild(guildId, sinceMs, clientId, clientSecret) {
  const all = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await gql(
      Q_REPORTS,
      { guildId, startTime: sinceMs || undefined, page },
      clientId,
      clientSecret,
    );
    const result = data.reportData?.reports;
    const batch  = result?.data ?? [];
    all.push(...batch);
    if (page >= (result?.last_page ?? 1)) break;
    page++;
  }
  return all;
}

/**
 * Fetch full fight list + actor list for a single report.
 *
 * @param {string} code          WCL report code (e.g. "AbCdEf12")
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {{ startTime, endTime, fights, masterData } | null}
 */
export async function getReportFights(code, clientId, clientSecret) {
  const data = await gql(Q_REPORT_FIGHTS, { code }, clientId, clientSecret);
  return data.reportData?.report ?? null;
}

/**
 * Fetch CombatantInfo events for a specific fight within a report.
 * Returns the raw `data` array of combatant event objects.
 *
 * @param {string}   code          WCL report code
 * @param {number}   fightId       Fight ID (integer)
 * @param {string}   clientId
 * @param {string}   clientSecret
 * @returns {object[]}
 */
export async function getCombatantInfo(code, fightId, clientId, clientSecret) {
  const data = await gql(Q_COMBATANT_INFO, { code, fightIds: [fightId] }, clientId, clientSecret);
  return data.reportData?.report?.events?.data ?? [];
}
