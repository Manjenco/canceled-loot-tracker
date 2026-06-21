/**
 * AdminItemDb — Item DB and Tier Items seeding via Blizzard API.
 * Global officer only. Accessible at /admin/item-db.
 *
 * Two cards:
 *   1. Item DB — fetch items from a Blizzard journal instance and write to D1
 *   2. Tier Items — fetch current-tier item sets (one per class) and write to D1
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiPath } from '../lib/api.js';
import ItemLink from '../components/ItemLink.jsx';

const DIFFICULTIES = [
  { value: 'MYTHIC',           label: 'Mythic' },
  { value: 'HEROIC',           label: 'Heroic' },
  { value: 'NORMAL',           label: 'Normal' },
  { value: 'LOOKING_FOR_RAID', label: 'LFR' },
  { value: 'MYTHIC_KEYSTONE',  label: 'Mythic+' },
];

// ── Item DB card ──────────────────────────────────────────────────────────────

function ItemDbCard({ seasonId, onStatsChange }) {
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
        body:        JSON.stringify({ instanceId: Number(instanceId), difficulty, replace, seasonId }),
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
    if (!window.confirm('Clear all item DB rows for the selected season? This removes every item in that season from the database.')) return;
    setClearing(true); setResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/clear'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ seasonId }),
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
          disabled={busy || !instanceId.trim() || !seasonId}
          style={{ alignSelf: 'flex-end' }}
        >
          {syncing ? 'Syncing…' : 'Sync Instance'}
        </button>

        <button
          className="btn-secondary"
          onClick={handleClear}
          disabled={busy || !seasonId}
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

function TierItemsCard({ seasonId, onStatsChange }) {
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
        body:        JSON.stringify({ sets, seasonId }),
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
        disabled={syncing || !seasonId || TIER_CLASSES.every(c => !setIds[c])}
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

// ── Instance combobox (type-to-search) ─────────────────────────────────────────

function InstanceCombobox({ instances, valueId, onSelect, disabled }) {
  const [query, setQuery] = useState('');
  const [open,  setOpen]  = useState(false);

  const selected = instances.find(i => String(i.id) === String(valueId));
  const needle   = query.trim().toLowerCase();
  const filtered = (needle
    ? instances.filter(i => i.name.toLowerCase().includes(needle) || String(i.id).includes(needle))
    : instances
  ).slice(0, 50);

  return (
    <div style={{ position: 'relative', minWidth: 280 }}>
      <input
        className="config-input"
        value={query}
        disabled={disabled}
        placeholder={selected ? `${selected.name} (#${selected.id})` : 'Type to search instances…'}
        onChange={e => { setQuery(e.target.value); setOpen(true); if (!e.target.value) onSelect(''); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ width: '100%' }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 30, top: '100%', left: 0, right: 0, marginTop: 2,
          maxHeight: 260, overflowY: 'auto',
          background: 'var(--card, #1A1A1A)', border: '1px solid var(--border, #333)', borderRadius: 4,
          boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
        }}>
          {filtered.map(i => (
            <div
              key={i.id}
              // onMouseDown (not onClick) so selection fires before the input's blur closes the list
              onMouseDown={() => { onSelect(String(i.id)); setQuery(i.name); setOpen(false); }}
              style={{
                padding: '5px 10px', cursor: 'pointer', fontSize: 13,
                background: String(i.id) === String(valueId) ? 'rgba(204,16,16,0.15)' : 'transparent',
              }}
            >
              <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)', marginRight: 8 }}>#{i.id}</span>
              {i.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Source Manifest ───────────────────────────────────────────────────────────

function SourceManifestCard({ seasonId }) {
  const [sources, setSources] = useState(null); // null = not loaded
  const [error,   setError]   = useState(null);

  // Add form
  const [instances,   setInstances]   = useState(null);
  const [instLoading, setInstLoading] = useState(false);
  const [addId,       setAddId]       = useState('');
  const [addDiff,     setAddDiff]     = useState('MYTHIC');
  const [adding,      setAdding]      = useState(false);

  const loadSources = useCallback(async () => {
    if (!seasonId) { setSources(null); return; }
    try {
      const r = await fetch(apiPath(`/api/admin/item-db/sources?seasonId=${seasonId}`), { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Failed to load sources');
      setSources(d.sources ?? []);
    } catch (e) { setError(e.message); }
  }, [seasonId]);

  useEffect(() => { loadSources(); }, [loadSources]);

  async function loadInstances() {
    setInstLoading(true);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/instances'), { credentials: 'include' });
      const d = await r.json();
      if (r.ok) setInstances(d.instances ?? []);
      else setError(d.error ?? 'Failed to load instances');
    } catch (e) { setError(e.message); }
    finally { setInstLoading(false); }
  }

  async function addSource() {
    if (!addId) return;
    setAdding(true); setError(null);
    try {
      const label = (instances ?? []).find(i => String(i.id) === String(addId))?.name ?? '';
      const r = await fetch(apiPath('/api/admin/item-db/sources'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId, sourceId: Number(addId), difficulty: addDiff, label }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Add failed');
      setAddId('');
      await loadSources();
    } catch (e) { setError(e.message); }
    finally { setAdding(false); }
  }

  async function toggle(src) {
    setError(null);
    try {
      await fetch(apiPath(`/api/admin/item-db/sources/${src.id}`), {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId, enabled: src.enabled !== 1 }),
      });
      await loadSources();
    } catch (e) { setError(e.message); }
  }

  async function remove(src) {
    if (!window.confirm(
      `Remove "${src.label || src.source_id}" (${src.difficulty}) from the manifest?\n\n` +
      'This only removes the source entry — items already imported from it stay in the Item DB.'
    )) return;
    setError(null);
    try {
      await fetch(apiPath(`/api/admin/item-db/sources/${src.id}?seasonId=${seasonId}`), { method: 'DELETE', credentials: 'include' });
      await loadSources();
    } catch (e) { setError(e.message); }
  }

  const list = sources ?? [];
  const td = { padding: '5px 10px 5px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-title">Source Manifest</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        The set of Blizzard journal instances that define this season’s item pool. <strong>Sync from
        manifest</strong> additively re-pulls every enabled source and upserts the union into the
        Item DB — the repeatable way to keep a season current (e.g. after a mid-season raid is added).
        Removing a source here does <em>not</em> delete items already imported from it.
      </p>

      {error && <p style={{ fontSize: 13, color: 'var(--danger, #e05)', marginBottom: 8 }}>Error: {error}</p>}

      {/* Source list */}
      {list.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          No sources yet — add a raid or M+ instance below.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
              <th style={{ textAlign: 'center', padding: '4px 10px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 70 }}>Enabled</th>
              <th style={{ textAlign: 'left',   padding: '4px 10px 8px 0', color: 'var(--text-muted)', fontWeight: 500 }}>Instance</th>
              <th style={{ textAlign: 'left',   padding: '4px 10px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 80 }}>ID</th>
              <th style={{ textAlign: 'left',   padding: '4px 10px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 120 }}>Difficulty</th>
              <th style={{ padding: '4px 0 8px', width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id} style={{ opacity: s.enabled === 1 ? 1 : 0.5 }}>
                <td style={{ ...td, textAlign: 'center' }}>
                  <input type="checkbox" checked={s.enabled === 1} onChange={() => toggle(s)} />
                </td>
                <td style={td}>{s.label || <span style={{ color: 'var(--text-muted)' }}>(no label)</span>}</td>
                <td style={{ ...td, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{s.source_id}</td>
                <td style={td}>{DIFFICULTIES.find(d => d.value === s.difficulty)?.label ?? s.difficulty}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button className="btn-icon-danger" onClick={() => remove(s)} title="Remove from manifest">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add form */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {instances ? (
          <InstanceCombobox instances={instances} valueId={addId} onSelect={setAddId} disabled={adding} />
        ) : (
          <>
            <input
              className="config-input config-input-narrow"
              value={addId}
              onChange={e => setAddId(e.target.value)}
              placeholder="Instance ID"
              style={{ width: 120 }}
            />
            <button className="btn-secondary" onClick={loadInstances} disabled={instLoading} style={{ fontSize: 12, padding: '3px 10px' }}>
              {instLoading ? 'Loading…' : 'Load instance list'}
            </button>
          </>
        )}
        <select className="lh-diff-select" value={addDiff} onChange={e => setAddDiff(e.target.value)}>
          {DIFFICULTIES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <button className="btn-secondary" onClick={addSource} disabled={adding || !addId}>
          {adding ? 'Adding…' : 'Add Source'}
        </button>
      </div>
    </div>
  );
}

// ── Manifest Update (diff + per-bucket apply) ──────────────────────────────────

function bucketColor(kind) {
  return kind === 'added' ? 'var(--bis, #4caf50)' : kind === 'removed' ? 'var(--danger, #e05)' : '#fbbf24';
}

function ManifestUpdateCard({ seasonId, onItemsChanged }) {
  const [diff,       setDiff]       = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [error,      setError]      = useState(null);
  const [applying,   setApplying]   = useState(null);  // bucket name currently applying
  const [applyMsg,   setApplyMsg]   = useState(null);

  // Clear any stale preview when the season changes.
  useEffect(() => { setDiff(null); setError(null); setApplyMsg(null); }, [seasonId]);

  // Attach Wowhead tooltips to the freshly-rendered diff item links.
  useEffect(() => { if (diff) window.$WowheadPower?.refreshLinks(); }, [diff]);

  async function preview() {
    setPreviewing(true); setError(null); setApplyMsg(null); setDiff(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/diff'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Preview failed');
      setDiff(d);
    } catch (e) { setError(e.message); }
    finally { setPreviewing(false); }
  }

  async function applyBucket(bucket) {
    setApplying(bucket); setApplyMsg(null);
    try {
      const r = await fetch(apiPath('/api/admin/item-db/apply'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId, buckets: [bucket] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Apply failed');
      const n = d.applied?.[bucket] ?? 0;
      setApplyMsg({ ok: true, text: `Applied ${bucket}: ${n} item${n !== 1 ? 's' : ''}.` });
      onItemsChanged?.();
      await preview(); // refresh the diff so the bucket empties
    } catch (e) {
      setApplyMsg({ error: e.message });
      setApplying(null);
    }
    finally { setApplying(null); }
  }

  const td = { padding: '4px 10px 4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' };

  function Bucket({ kind, label, items, applyLabel, disabled, disabledReason, render }) {
    const color = bucketColor(kind);
    return (
      <details style={{ marginBottom: 8 }} open={items.length > 0 && items.length <= 40}>
        <summary style={{ cursor: 'pointer', fontSize: 14, color }}>
          {label}: <strong>{items.length}</strong>
        </summary>
        {items.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border, #333)', borderRadius: 4, marginBottom: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>{items.map(render)}</tbody>
              </table>
            </div>
            <button
              className="btn-secondary"
              onClick={() => applyBucket(kind)}
              disabled={!!applying || disabled}
              title={disabled ? disabledReason : undefined}
            >
              {applying === kind ? 'Applying…' : applyLabel}
            </button>
            {disabled && disabledReason && (
              <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>{disabledReason}</span>
            )}
          </div>
        )}
      </details>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-title">Update Items from Manifest</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        Re-pulls the manifest and shows what would change versus this season’s current items —
        review and apply each bucket separately. <strong>Added</strong> and <strong>Changed</strong>
        upsert in place (safe anytime). <strong>Removed</strong> hard-deletes and is only allowed on a
        non-current season with a clean pull.
      </p>

      <button className="btn-primary" onClick={preview} disabled={previewing || !seasonId}>
        {previewing ? 'Computing…' : 'Preview Update'}
      </button>

      {error && <p style={{ marginTop: 12, fontSize: 13, color: 'var(--danger, #e05)' }}>Error: {error}</p>}

      {applyMsg && (
        <p style={{ marginTop: 12, fontSize: 13, color: applyMsg.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
          {applyMsg.ok ? applyMsg.text : `Error: ${applyMsg.error}`}
        </p>
      )}

      {diff && (
        <div style={{ marginTop: 16 }}>
          {diff.sourceErrors?.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', border: '1px solid #92400e', borderRadius: 4, fontSize: 13 }}>
              <p style={{ color: '#fbbf24', margin: '0 0 4px' }}>⚠ {diff.sourceErrors.length} source(s) failed to fetch — removals are blocked to avoid deleting from a partial pull.</p>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)' }}>
                {diff.sourceErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {diff.counts.added === 0 && diff.counts.changed === 0 && diff.counts.removed === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--bis)' }}>✓ This season’s Item DB already matches the manifest — nothing to apply.</p>
          ) : (
            <>
              <Bucket
                kind="added" label="Added" items={diff.added} applyLabel={`Apply ${diff.counts.added} Add${diff.counts.added !== 1 ? 's' : ''}`}
                render={i => (
                  <tr key={i.itemId}>
                    <td style={{ ...td, fontFamily: 'monospace', color: 'var(--text-muted)', width: 70 }}>{i.itemId}</td>
                    <td style={td}><ItemLink itemId={i.itemId} name={i.name} /></td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i.slot}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i.instance}</td>
                  </tr>
                )}
              />
              <Bucket
                kind="changed" label="Changed" items={diff.changed} applyLabel={`Apply ${diff.counts.changed} Change${diff.counts.changed !== 1 ? 's' : ''}`}
                render={i => (
                  <tr key={i.itemId}>
                    <td style={{ ...td, fontFamily: 'monospace', color: 'var(--text-muted)', width: 70 }}>{i.itemId}</td>
                    <td style={td}><ItemLink itemId={i.itemId} name={i.name} /></td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>
                      {i.changedFields.map(f => `${f}: ${i.old[f]} → ${f === 'is_tier_token' ? (i.isTierToken ? 1 : 0) : (i[{ source_type: 'sourceType', source_name: 'sourceName', armor_type: 'armorType' }[f] ?? f])}`).join(', ')}
                    </td>
                  </tr>
                )}
              />
              <Bucket
                kind="removed" label="Removed" items={diff.removed}
                applyLabel={`Apply ${diff.counts.removed} Removal${diff.counts.removed !== 1 ? 's' : ''}`}
                disabled={!diff.removalsAllowed}
                disabledReason={
                  diff.isCurrent ? 'Disabled — current (live) season is additive-only.'
                  : diff.partial ? 'Disabled — a source failed to fetch this run.'
                  : undefined
                }
                render={i => (
                  <tr key={i.item_id}>
                    <td style={{ ...td, fontFamily: 'monospace', color: 'var(--text-muted)', width: 70 }}>{i.item_id}</td>
                    <td style={td}>
                      <ItemLink itemId={i.item_id} name={i.name} />
                      {i.referenced && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--danger, #e05)' }} title="Referenced by Default BIS — removal will be blocked">⚠ in Default BIS</span>
                      )}
                    </td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i.slot}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i.instance}</td>
                  </tr>
                )}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Season Items viewer ───────────────────────────────────────────────────────

function SeasonItemsCard({ seasonId, refreshNonce }) {
  const [items,   setItems]   = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // Filters
  const [q,        setQ]        = useState('');
  const [slot,     setSlot]     = useState('');
  const [instance, setInstance] = useState('');
  const [armor,    setArmor]    = useState('');
  const [tierOnly, setTierOnly] = useState(false);

  useEffect(() => {
    if (!seasonId) { setItems(null); return; }
    let live = true;
    setLoading(true); setError(null);
    fetch(apiPath(`/api/admin/item-db/list?seasonId=${seasonId}`), { credentials: 'include' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!live) return;
        if (!ok) throw new Error(d.error ?? 'Failed to load items');
        setItems(d.items ?? []);
      })
      .catch(e => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [seasonId, refreshNonce]);

  // Re-attach Wowhead tooltips whenever the rendered rows change (load or filter).
  useEffect(() => { if (items) window.$WowheadPower?.refreshLinks(); }, [items, q, slot, instance, armor, tierOnly]);

  const all = items ?? [];
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort();
  const slots     = uniq(all.map(i => i.slot));
  const instances = uniq(all.map(i => i.instance));
  const armors    = uniq(all.map(i => i.armor_type));

  const needle = q.trim().toLowerCase();
  const filtered = all.filter(i => {
    if (needle && !i.name.toLowerCase().includes(needle) && !String(i.item_id).includes(needle)) return false;
    if (slot     && i.slot       !== slot)     return false;
    if (instance && i.instance   !== instance) return false;
    if (armor    && i.armor_type !== armor)    return false;
    if (tierOnly && i.is_tier_token !== 1)     return false;
    return true;
  });

  const th = { textAlign: 'left', padding: '4px 10px 8px 0', color: 'var(--text-muted)', fontWeight: 500, position: 'sticky', top: 0, background: 'var(--card, #1A1A1A)' };
  const td = { padding: '5px 10px 5px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-title">Season Items</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        Everything currently stored in this season’s Item DB. Use the filters to audit coverage
        — e.g. confirm a newly-added raid’s items are present, or spot gaps by slot.
      </p>

      {error && <p style={{ fontSize: 13, color: 'var(--danger, #e05)', marginBottom: 8 }}>Error: {error}</p>}

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input
          className="config-input"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search name or item ID…"
          style={{ maxWidth: 240 }}
        />
        <select className="lh-diff-select" value={slot} onChange={e => setSlot(e.target.value)}>
          <option value="">All slots</option>
          {slots.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="lh-diff-select" value={instance} onChange={e => setInstance(e.target.value)}>
          <option value="">All sources</option>
          {instances.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="lh-diff-select" value={armor} onChange={e => setArmor(e.target.value)}>
          <option value="">All armor types</option>
          {armors.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={tierOnly} onChange={e => setTierOnly(e.target.checked)} />
          Tier tokens only
        </label>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {filtered.length}{filtered.length !== all.length ? ` / ${all.length}` : ''} item{all.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading && !items ? (
        <div className="loading">Loading…</div>
      ) : all.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No items in this season yet.</p>
      ) : (
        <div style={{ maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border, #333)', borderRadius: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...th, paddingLeft: 10, width: 80 }}>ID</th>
                <th style={th}>Name</th>
                <th style={th}>Slot</th>
                <th style={th}>Source</th>
                <th style={th}>Armor</th>
                <th style={th}>Difficulty</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(i => (
                <tr key={i.id}>
                  <td style={{ ...td, paddingLeft: 10, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{i.item_id}</td>
                  <td style={td}>
                    <ItemLink itemId={i.item_id} name={i.name} />
                    {i.is_tier_token === 1 && (
                      <span style={{ marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 3, background: 'rgba(204,16,16,0.18)', color: 'var(--primary, #CC1010)' }}>
                        Tier
                      </span>
                    )}
                  </td>
                  <td style={td}>{i.slot}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{i.instance || i.source_name}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{i.armor_type}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{i.difficulty}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, paddingLeft: 10, color: 'var(--text-muted)' }}>No items match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminItemDb() {
  const [seasons,  setSeasons]  = useState([]);
  const [seasonId, setSeasonId] = useState(null);
  const [stats,    setStats]    = useState(null);
  const [nonce,    setNonce]    = useState(0); // bump to force stats + viewer reload after writes

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  // Load seasons once; default the picker to the current season.
  useEffect(() => {
    fetch(apiPath('/api/admin/seasons'), { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const list = d.seasons ?? [];
        setSeasons(list);
        const current = list.find(s => s.is_current) ?? list[0];
        if (current) setSeasonId(current.id);
      })
      .catch(() => { /* non-critical */ });
  }, []);

  // Reload stats whenever the season changes or a write happens.
  useEffect(() => {
    if (!seasonId) { setStats(null); return; }
    let live = true;
    fetch(apiPath(`/api/admin/item-db/stats?seasonId=${seasonId}`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (live && d) setStats(d); })
      .catch(() => { /* non-critical */ });
    return () => { live = false; };
  }, [seasonId, nonce]);

  const selected = seasons.find(s => s.id === seasonId);

  return (
    <div>
      <h2 className="page-title">Item Database</h2>

      {/* ── Target season picker ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Target Season</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Seeding writes the Item DB and Tier Items for the selected season. You can populate a
          non-current season here, then activate it later on the{' '}
          <Link to="/admin/seasons" style={{ color: 'var(--accent, #4caf50)' }}>Seasons</Link> page.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <select
            className="lh-diff-select"
            value={seasonId ?? ''}
            onChange={e => setSeasonId(Number(e.target.value))}
            disabled={!seasons.length}
          >
            {seasons.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}{s.is_current ? ' (current)' : ''}
              </option>
            ))}
          </select>
          {stats && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              In this season:{' '}
              <strong style={{ color: 'var(--text)' }}>{stats.itemDb.toLocaleString()}</strong> item rows,{' '}
              <strong style={{ color: 'var(--text)' }}>{stats.tierItems}</strong> tier item rows
            </span>
          )}
          {selected && !selected.is_current && (
            <span style={{ fontSize: 13, color: '#fbbf24' }}>
              ⚠ Editing a non-current season
            </span>
          )}
        </div>
      </div>

      <SourceManifestCard seasonId={seasonId} />
      <ManifestUpdateCard seasonId={seasonId} onItemsChanged={refresh} />
      <ItemDbCard seasonId={seasonId} onStatsChange={refresh} />
      <TierItemsCard seasonId={seasonId} onStatsChange={refresh} />
      <SeasonItemsCard seasonId={seasonId} refreshNonce={nonce} />
    </div>
  );
}
