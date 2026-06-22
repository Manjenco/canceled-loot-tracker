import { useState, useEffect } from 'react';
import { apiPath } from '../lib/api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pass ISO dates through; convert a stray Sheets serial to ISO if one slipped in. */
function normaliseDate(value) {
  if (!value) return '';
  const num = Number(value);
  if (!isNaN(num) && num > 0 && num < 200000) {
    return new Date((num - 25569) * 86400 * 1000).toISOString().split('T')[0];
  }
  return String(value);
}

async function loadSeasons() {
  const r = await fetch(apiPath('/api/admin/seasons'), { credentials: 'include' });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.seasons ?? [];
}

function ResultMsg({ result }) {
  if (!result) return null;
  return (
    <p style={{ marginTop: 10, fontSize: 13, color: result.ok ? 'var(--bis)' : 'var(--danger, #e05)' }}>
      {result.ok ? (result.msg ?? 'Saved.') : `Error: ${result.error}`}
    </p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminSeasons() {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [seasons, setSeasons] = useState([]);

  // Per-row editable buffers: { [id]: { name, startDate } }
  const [edits,    setEdits]    = useState({});
  const [rowState, setRowState] = useState({}); // { [id]: { saving, settingCurrent, result } }

  // New-season form
  const [newName,    setNewName]    = useState('');
  const [newStart,   setNewStart]   = useState('');
  const [creating,   setCreating]   = useState(false);
  const [createResult, setCreateResult] = useState(null);

  function hydrate(list) {
    setSeasons(list);
    setEdits(Object.fromEntries(list.map(s => [s.id, { name: s.name, startDate: normaliseDate(s.start_date), mplusWse: s.mplus_wse ?? '' }])));
  }

  async function refresh() {
    const list = await loadSeasons();
    hydrate(list);
  }

  useEffect(() => {
    loadSeasons()
      .then(hydrate)
      .catch(e => setError(e.message ?? 'Failed to load seasons'))
      .finally(() => setLoading(false));
  }, []);

  const setRow = (id, patch) => setRowState(s => ({ ...s, [id]: { ...s[id], ...patch } }));
  const setEdit = (id, patch) => setEdits(e => ({ ...e, [id]: { ...e[id], ...patch } }));

  async function saveSeason(id) {
    const { name, startDate, mplusWse } = edits[id];
    if (!name?.trim()) { setRow(id, { result: { error: 'Name is required' } }); return; }
    setRow(id, { saving: true, result: null });
    try {
      const r = await fetch(apiPath(`/api/admin/seasons/${id}`), {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          startDate: startDate ?? '',
          mplusWse: (mplusWse === '' || mplusWse == null) ? null : Number(mplusWse),
        }),
      });
      const d = await r.json();
      setRow(id, { result: d.ok ? { ok: true } : { error: d.error ?? 'Save failed' } });
      if (d.ok) await refresh();
    } catch {
      setRow(id, { result: { error: 'Request failed' } });
    } finally {
      setRow(id, { saving: false });
    }
  }

  async function makeCurrent(id) {
    const season = seasons.find(s => s.id === id);
    if (!window.confirm(
      `Set "${season?.name}" as the current season?\n\n` +
      'Every page (dashboard, council, loot history, BIS) will switch to showing this ' +
      'season’s data, and new loot / WCL syncs will be recorded against it. ' +
      'Other seasons’ data is preserved and unaffected.'
    )) return;
    setRow(id, { settingCurrent: true, result: null });
    try {
      const r = await fetch(apiPath(`/api/admin/seasons/${id}/set-current`), {
        method: 'POST', credentials: 'include',
      });
      const d = await r.json();
      setRow(id, { result: d.ok ? { ok: true, msg: 'Now the current season.' } : { error: d.error ?? 'Failed' } });
      if (d.ok) await refresh();
    } catch {
      setRow(id, { result: { error: 'Request failed' } });
    } finally {
      setRow(id, { settingCurrent: false });
    }
  }

  async function detectWse(id) {
    setRow(id, { detecting: true, result: null });
    try {
      const r = await fetch(apiPath('/api/admin/item-db/detect-mplus-wse'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId: id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Detect failed');
      const top = d.suggestions?.[0];
      if (!top) { setRow(id, { result: { error: 'No shared WSE found across this season’s M+ sources.' } }); return; }
      setEdit(id, { mplusWse: String(top.wse) });
      setRow(id, { result: { ok: true, msg: `Suggested WSE ${top.wse} (shared by ${top.dungeonCount} dungeon${top.dungeonCount !== 1 ? 's' : ''}). Review, then Save.` } });
    } catch (e) {
      setRow(id, { result: { error: e.message } });
    } finally {
      setRow(id, { detecting: false });
    }
  }

  async function createSeason() {
    if (!newName.trim()) { setCreateResult({ error: 'Name is required' }); return; }
    setCreating(true); setCreateResult(null);
    try {
      const r = await fetch(apiPath('/api/admin/seasons'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), startDate: newStart ?? '' }),
      });
      const d = await r.json();
      if (d.ok) {
        setCreateResult({ ok: true, msg: 'Season created. Use “Set current” to activate it.' });
        setNewName(''); setNewStart('');
        await refresh();
      } else {
        setCreateResult({ error: d.error ?? 'Create failed' });
      }
    } catch {
      setCreateResult({ error: 'Request failed' });
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="loading">Loading…</div>;
  if (error)   return <div className="page-error">{error}</div>;

  const dirty = (s) => {
    const e = edits[s.id] ?? {};
    return e.name !== s.name
      || (e.startDate ?? '') !== normaliseDate(s.start_date)
      || String(e.mplusWse ?? '') !== String(s.mplus_wse ?? '');
  };

  return (
    <div>
      <h2 className="page-title">Seasons</h2>

      <div className="card">
        <div className="card-title">All Seasons</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Each season partitions its own loot, raids, BIS, item DB, and tier data. Exactly one
          season is current at a time — that’s the one shown across the app and written to by
          new loot imports and WCL syncs. Switching the current season never deletes data.
        </p>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 60 }}>ID</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500 }}>Name</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 160 }}>Start Date</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 200 }} title="Current Mythic+ WorldStateExpression gate (DB2). Used to pick this season's M+ loot.">M+ WSE</th>
              <th style={{ textAlign: 'center', padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 110 }}>Current</th>
              <th style={{ textAlign: 'right',  padding: '4px 0 8px',     color: 'var(--text-muted)', fontWeight: 500, width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {seasons.map(s => {
              const e  = edits[s.id] ?? { name: '', startDate: '' };
              const rs = rowState[s.id] ?? {};
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px 8px 8px 0', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{s.id}</td>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <input
                      className="config-input"
                      value={e.name}
                      onChange={ev => setEdit(s.id, { name: ev.target.value })}
                      placeholder="Season name"
                    />
                  </td>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <input
                      className="config-input config-input-narrow"
                      value={e.startDate}
                      onChange={ev => setEdit(s.id, { startDate: ev.target.value })}
                      placeholder="YYYY-MM-DD"
                    />
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', whiteSpace: 'nowrap' }}>
                    <input
                      className="config-input config-input-narrow"
                      style={{ width: 84 }}
                      value={e.mplusWse ?? ''}
                      onChange={ev => setEdit(s.id, { mplusWse: ev.target.value })}
                      placeholder="WSE id"
                    />
                    <button
                      className="btn-secondary"
                      style={{ marginLeft: 6, fontSize: 12, padding: '3px 8px' }}
                      onClick={() => detectWse(s.id)}
                      disabled={rs.detecting}
                      title="Suggest the WSE shared across this season's M+ manifest sources"
                    >
                      {rs.detecting ? '…' : 'Detect'}
                    </button>
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', textAlign: 'center' }}>
                    {s.is_current
                      ? <span style={{ color: '#4caf50', fontWeight: 600 }}>● Current</span>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="btn-secondary"
                      style={{ marginRight: 8 }}
                      onClick={() => saveSeason(s.id)}
                      disabled={rs.saving || !dirty(s)}
                    >
                      {rs.saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => makeCurrent(s.id)}
                      disabled={s.is_current || rs.settingCurrent}
                    >
                      {rs.settingCurrent ? 'Setting…' : 'Set current'}
                    </button>
                    <ResultMsg result={rs.result} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">New Season</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Creates an empty season. It is <strong>not</strong> made current automatically — seed its
          item DB and tier items first, then use “Set current” when you’re ready to switch.
        </p>
        <div className="config-field">
          <label className="config-label">Name</label>
          <input
            className="config-input"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="e.g. Season 2 — Manaforge Omega"
          />
        </div>
        <div className="config-field">
          <label className="config-label">Start Date</label>
          <p className="config-hint">ISO date (YYYY-MM-DD). Used as the cutoff for WCL reports and historical data in this season.</p>
          <input
            className="config-input config-input-narrow"
            value={newStart}
            onChange={e => setNewStart(e.target.value)}
            placeholder="e.g. 2026-03-01"
          />
        </div>
        <button className="btn-primary" onClick={createSeason} disabled={creating}>
          {creating ? 'Creating…' : 'Create Season'}
        </button>
        <ResultMsg result={createResult} />
      </div>
    </div>
  );
}
