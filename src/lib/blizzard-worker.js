/**
 * blizzard-worker.js — Blizzard Game Data API client for Cloudflare Workers.
 *
 * Functionally identical to scripts/blizzard.js but:
 *   - Uses btoa() instead of Buffer (Worker-native, no Node dependency)
 *   - Accepts credentials as a `creds` object instead of reading process.env
 *   - No module-level side effects (no console.log on import)
 *
 * All exported functions accept a `creds` object: { clientId, clientSecret, region? }
 * region defaults to 'us'.
 */

const OAUTH_URL = 'https://oauth.battle.net/token';

function apiBase(region)  { return `https://${region}.api.blizzard.com`; }
function namespace(region) { return `static-${region}`; }

// Module-level token cache — valid for the life of the Worker isolate (usually minutes).
let _token       = null;
let _tokenExpiry = 0;

async function getToken(clientId, clientSecret) {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Blizzard auth failed (${res.status}): ${await res.text()}`);
  }

  const data   = await res.json();
  _token       = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

async function bFetch(path, params = {}, { clientId, clientSecret, region = 'us' } = {}) {
  const token = await getToken(clientId, clientSecret);
  const url   = new URL(apiBase(region) + path);

  url.searchParams.set('namespace', namespace(region));
  url.searchParams.set('locale', 'en_US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Blizzard API ${res.status}: GET ${path}`);
  return res.json();
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

export async function pLimit(tasks, concurrency = 5) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all journal instances (raids + dungeons). */
export async function listInstances(creds) {
  const data = await bFetch('/data/wow/journal-instance/index', {}, creds);
  return (data.instances ?? []).sort((a, b) => b.id - a.id);
}

/** Get a journal instance by ID (includes its encounters list). */
export async function getInstance(instanceId, creds) {
  return bFetch(`/data/wow/journal-instance/${instanceId}`, {}, creds);
}

/** Get a journal encounter by ID at a given difficulty. */
export async function getEncounter(encounterId, difficulty = 'MYTHIC', creds) {
  return bFetch(`/data/wow/journal-encounter/${encounterId}`, { difficulty }, creds);
}

/** Get full item details by Blizzard item ID. */
export async function getItemDetails(itemId, creds) {
  return bFetch(`/data/wow/item/${itemId}`, {}, creds);
}

/** Get an item set by ID (returns set name + item list). */
export async function getItemSet(itemSetId, creds) {
  return bFetch(`/data/wow/item-set/${itemSetId}`, {}, creds);
}

/**
 * Fetch all items for a journal instance at the given difficulty.
 * Returns array of { details, encounterName, instanceName, difficulty } objects.
 * Encounters are fetched in parallel (bounded to 5), items deduplicated + detail-fetched (bounded to 8).
 */
export async function fetchRaidItems(instanceId, difficulty = 'MYTHIC', creds) {
  const instance = await getInstance(instanceId, creds);
  const instanceName = instance.name;

  // Fetch all encounters in parallel
  const encounterResults = await pLimit(
    (instance.encounters ?? []).map(enc => async () => {
      try {
        const encounter = await getEncounter(enc.id, difficulty, creds);
        return (encounter.items ?? []).map(item => ({
          item, encounterName: encounter.name, instanceName, difficulty,
        }));
      } catch {
        return [];
      }
    }),
    5,
  );

  const encounterItems = encounterResults.flat();

  // Deduplicate by actual item ID
  const seen   = new Set();
  const unique = encounterItems.filter(({ item }) => {
    const realId = item.item?.id ?? item.id;
    if (seen.has(realId)) return false;
    seen.add(realId);
    return true;
  });

  // Fetch full details for each unique item
  const detailed = await pLimit(
    unique.map(({ item, encounterName, instanceName, difficulty }) => async () => {
      const realId = item.item?.id ?? item.id;
      try {
        const details = await getItemDetails(realId, creds);
        return { details, encounterName, instanceName, difficulty };
      } catch {
        return null;
      }
    }),
    8,
  );

  return detailed.filter(Boolean);
}
