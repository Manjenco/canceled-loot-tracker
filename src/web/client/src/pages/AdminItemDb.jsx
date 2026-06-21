/**
 * AdminItemDb — Item DB and Tier Items seeding via Blizzard API.
 * Global officer only. Accessible at /admin/item-db.
 *
 * Two cards:
 *   1. Item DB — fetch items from a Blizzard journal instance and write to D1
 *   2. Tier Items — fetch current-tier item sets (one per class) and write to D1
 */

import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

const DIFFICULTIES = [
  { value: 'MYTHIC',           label: 'Mythic' },
  { value: 'HEROIC',           label: 'Heroic' },
  { value: 'NORMAL',           label: 'Normal' },
  { value: 'LOOKING_FOR_RAID', label: 'LFR' },
  { value: 'MYTHIC_KEYSTONE',  label: 'Mythic+' },
];

// ── Item DB card ──────────────────────────────────────────────────────────────

function ItemDbCard({ onStatsChange }) {
  const [instanceId,   setInstanceId]   = useState('');
  const [difficulty,   setDifficulty]   = useState('MYTHIC');
  const [replace,      setReplace]      = useState(false);
  const [syncing,      setSyncing]      = useState(false);
  const [clearing,     setClearing]     = useState(false);
  const [result,       setResult]       = useState(null);

  // Instance search
  const [instances,    setInstances]    = useState(null);  // null = not loaded
  const [instLoading,  setInstLoading]  = useState(false);
  const [instError,    setInstError]    = useState(null);
  const [search,       setSearch]       = useState('');

  async function loadInstances() {
    setInstLoading(true); setInstError(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/instances'), { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setInstances(d.instances ?? []);
    } catch (err) {
      setInstError(err.message);
    } finally {
      setInstLoading(false);
    }
  }

  async function handleSync() {
    if (!instanceId.trim()) return;
    setSyncing(true); setResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/sync'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ instanceId: Number(instanceId), difficulty, replace }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setResult({ ok: true, data: d });
      onStatsChange?.();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  async function handleClear() {
    if (!window.confirm('Clear all item DB rows? This will remove all items from the database.')) return;
    setClearing(true); setResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/clear'), {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setResult({ ok: true, data: { message: 'Item DB cleared.' } });
      onStatsChange?.();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setClearing(false);
    }
  }

  const busy = syncing || clearing;

  const filteredInstances = (instances ?? []).filter(i =>
    !search.trim() || i.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="card">
      <div className="card-title">Item DB</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        Fetch items from a Blizzard journal instance (raid or dungeon) and write them to the
        Item DB. Each run upserts by item ID — existing rows are updated, new rows are inserted.
        Enable <strong>Replace all</strong> to wipe the table before writing (useful for a clean season reset).
      </p>

      {/* Instance picker */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 auto' }}>
          <label className="config-label" style={{ display: 'block', marginBottom: 4 }}>
            Journal Instance ID
          </label>
          <input
            className="config-input config-input-narrow"
            value={instanceId}
            onChange={e => setInstanceId(e.target.value)}
            placeholder="e.g. 1273"
            disabled={busy}
            style={{ width: 120 }}
          />
        </div>

        <div style={{ flex: '0 0 auto' }}>
          <label className="config-label" style={{ display: 'block', marginBottom: 4 }}>
            Difficulty
          </label>
          <select
            className="lh-diff-select"
            value={difficulty}
            onChange={e => setDifficulty(e.target.value)}
            disabled={busy}
          >
            {DIFFICULTIES.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 2 }}>
          <input
            type="checkbox"
            checked={replace}
            onChange={e => setReplace(e.target.checked)}
            disabled={busy}
          />
          Replace all
        </label>

        <button
          className="btn-primary"
          onClick={handleSync}
          disabled={busy || !instanceId.trim()}
          style={{ alignSelf: 'flex-end' }}
        >
          {syncing ? 'Syncing…' : 'Sync Instance'}
        </button>

        <button
          className="btn-secondary"
          onClick={handleClear}
          disabled={busy}
          style={{ alignSelf: 'flex-end' }}
        >
          {clearing ? 'Clearing…' : 'Clear All'}
        </button>
      </div>

      {result && (
        <p style={{ fontSize: 13, color: result.ok ? 'var(--bis)' : 'var(--danger, #e05)', marginBottom: 12 }}>
          {result.ok
            ? (result.data.message ?? `Done — ${result.data.total} items synced from ${result.data.instanceName} (${result.data.difficulty}).`)
            : `Error: ${result.error}`
          }
        </p>
      )}

      {/* Instance browser */}
      <div style={{ borderTop: '1px solid var(--border, #333)', paddingTop: 12, marginTop: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Not sure of the instance ID? Browse available journal instances:
          </span>
          {!instances && (
            <button className="btn-secondary" onClick={loadInstances} disabled={instLoading} style={{ fontSize: 12, padding: '3px 10px' }}>
              {instLoading ? 'Loading…' : 'Load Instance List'}
            </button>
          )}
        </div>

        {instError && (
          <p style={{ fontSize: 13, color: 'var(--danger, #e05)', marginBottom: 8 }}>
            Error loading instances: {instError}
          </p>
        )}

        {instances && (
          <>
            <input
              className="config-input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name…"
              style={{ marginBottom: 8, maxWidth: 300 }}
            />
            <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 13, border: '1px solid var(--border, #333)', borderRadius: 4 }}>
              {filteredInstances.length === 0
                ? <div style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>No results</div>
                : filteredInstances.map(inst => (
                  <div
                    key={inst.id}
                    style={{
                      display: 'flex', gap: 12, padding: '5px 12px', cursor: 'pointer',
                      background: String(instanceId) === String(inst.id) ? 'rgba(204,16,16,0.12)' : 'transparent',
                    }}
                    onClick={() => setInstanceId(String(inst.id))}
                  >
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', minWidth: 48 }}>{inst.id}</span>
                    <span>{inst.name}</span>
                  </div>
                ))
              }
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tier Items card ───────────────────────────────────────────────────────────

const TIER_CLASSES = [
  'Death Knight', 'Demon Hunter', 'Druid', 'Evoker', 'Hunter',
  'Mage', 'Monk', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior',
];

function TierItemsCard({ onStatsChange }) {
  // One set ID per class — stored as parallel arrays indexed by TIER_CLASSES
  const [setIds, setSetIds] = useState(() => Object.fromEntries(TIER_CLASSES.map(c => [c, ''])));
  const [syncing, setSyncing] = useState(false);
  const [result,  setResult]  = useState(null);

  async function handleSync() {
    const sets = TIER_CLASSES
      .map(cls => ({ setId: Number(setIds[cls]), className: cls }))
      .filter(s => s.setId);

    if (!sets.length) {
      setResult({ error: 'Enter at least one item set ID.' });
      return;
    }

    setSyncing(true); setResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/tier-items/sync'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ sets }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setResult({ ok: true, data: d });
      onStatsChange?.();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-title">Tier Items</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        Enter the Blizzard item set ID for each class's current tier. Run once per season when
        new tier content releases. Find set IDs at{' '}
        <a href="https://www.wowhead.com/item-sets" target="_blank" rel="noreferrer" style={{ color: 'var(--primary, #CC1010)' }}>
          wowhead.com/item-sets
        </a>.
        Leave a class blank to skip it.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px 16px', marginBottom: 16 }}>
        {TIER_CLASSES.map(cls => (
          <label key={cls} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ minWidth: 110, color: 'var(--text-muted)' }}>{cls}</span>
            <input
              className="config-input config-input-narrow"
              value={setIds[cls]}
              onChange={e => setSetIds(prev => ({ ...prev, [cls]: e.target.value }))}
              placeholder="Set ID"
              disabled={syncing}
              style={{ width: 80 }}
            />
          </label>
        ))}
      </div>

      <button
        className="btn-primary"
        onClick={handleSync}
        disabled={syncing || TIER_CLASSES.every(c => !setIds[c])}
      >
        {syncing ? 'Syncing…' : 'Sync Tier Items'}
      </button>

      {result && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          {result.error ? (
            <p style={{ color: 'var(--danger, #e05)' }}>Error: {result.error}</p>
          ) : (
            <>
              <p style={{ color: 'var(--bis)', marginBottom: 6 }}>
                Done — {result.data.total} tier item rows written.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)' }}>
                {(result.data.sets ?? []).map(s => (
                  <li key={s.className}>
                    {s.className}: set {s.setId} ({s.setName}) — {s.slots} slot{s.slots !== 1 ? 's' : ''}
                  </li>
                ))}
              </ul>
              {result.data.errors?.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--danger, #e05)' }}>
                  {result.data.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminItemDb() {
  const [stats, setStats] = useState(null);

  async function loadStats() {
    try {
      const r = await fetch(apiPath('/api/admin/item-db/stats'), { credentials: 'include' });
      if (r.ok) setStats(await r.json());
    } catch { /* non-critical */ }
  }

  useEffect(() => { loadStats(); }, []);

  return (
    <div>
      <h2 className="page-title">Item Database</h2>

      {stats && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          Current DB:{' '}
          <strong style={{ color: 'var(--text)' }}>{stats.itemDb.toLocaleString()}</strong> item rows,{' '}
          <strong style={{ color: 'var(--text)' }}>{stats.tierItems}</strong> tier item rows
        </p>
      )}

      <ItemDbCard onStatsChange={loadStats} />
      <TierItemsCard onStatsChange={loadStats} />
    </div>
  );
}
