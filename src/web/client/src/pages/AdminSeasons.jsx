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
  return d; // { seasons, currentSeasonId }
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
  const [currentSeasonId, setCurrentSeasonId] = useState(null); // resolved current (override or date rule)

  // Per-row editable buffers: { [id]: { name, startDate } }
  const [edits,    setEdits]    = useState({});
  const [rowState, setRowState] = useState({}); // { [id]: { saving, settingCurrent, result } }

  // New-season form
  const [newName,    setNewName]    = useState('');
  const [newStart,   setNewStart]   = useState('');
  const [creating,   setCreating]   = useState(false);
  const [createResult, setCreateResult] = useState(null);

  function hydrate(d) {
    const list = d.seasons ?? [];
    setSeasons(list);
    setCurrentSeasonId(d.currentSeasonId ?? null);
    setEdits(Object.fromEntries(list.map(s => [s.id, { name: s.name, startDate: normaliseDate(s.start_date), mplusWse: s.mplus_wse ?? '', preRelease: !!s.pre_release, zoneIds: s.zone_ids ?? '' }])));
  }

  async function refresh() {
    hydrate(await loadSeasons());
  }

  async function clearOverride() {
    if (!window.confirm('Clear the manual current-season override? The current season will then be resolved automatically — the latest season whose start date has already passed.')) return;
    try {
      const r = await fetch(apiPath('/api/admin/seasons/clear-current'), { method: 'POST', credentials: 'include' });
      if ((await r.json()).ok) await refresh();
    } catch { /* non-critical */ }
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
    const { name, startDate, mplusWse, preRelease, zoneIds } = edits[id];
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
          preRelease: !!preRelease,
          zoneIds: (zoneIds ?? '').trim(),   // '' deliberately clears (pauses WCL sync for the season)
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

  async function detectZones(id) {
    setRow(id, { zonesLoading: true, result: null });
    try {
      const r = await fetch(apiPath(`/api/admin/seasons/${id}/wcl-zones`), { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Failed to list zones');
      setRow(id, { zonePicker: d });                       // { expansion, zones, guess, raidInstanceNames }
      if (d.guess?.zoneId) setEdit(id, { zoneIds: d.guess.zoneId }); // pre-select the best guess
    } catch (e) {
      setRow(id, { result: { error: e.message } });
    } finally {
      setRow(id, { zonesLoading: false });
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
      || String(e.mplusWse ?? '') !== String(s.mplus_wse ?? '')
      || !!e.preRelease !== !!s.pre_release
      || String(e.zoneIds ?? '') !== String(s.zone_ids ?? '');
  };

  return (
    <div>
      <h2 className="page-title">Seasons</h2>

      <div className="card">
        <div className="card-title">All Seasons</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Each season partitions its own loot, raids, BIS, item DB, and tier data. The
          <strong> current</strong> season — where new loot and WCL syncs are written — is normally
          resolved automatically: the latest season whose start date has already passed (pre-release
          seasons are excluded). Use <em>Set current</em> to pin one manually as an override. Everyone
          can switch which season they’re <em>viewing</em> from the top bar; that never affects writes.
        </p>
        {seasons.some(s => s.is_current) && (
          <p style={{ fontSize: 13, marginBottom: 16 }}>
            <span style={{ color: '#fbbf24' }}>⚙ A manual current-season override is active.</span>{' '}
            <button className="btn-link" onClick={clearOverride}>Clear it (use automatic)</button>
          </p>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 60 }}>ID</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500 }}>Name</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 160 }}>Start Date</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 200 }} title="Current Mythic+ WorldStateExpression gate (DB2). Used to pick this season's M+ loot.">M+ WSE</th>
              <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 210 }} title="WCL zone IDs for this season's raid (pipe-separated). WCL attendance/worn-BIS sync only counts fights in these zones. Blank pauses sync until the raid is live on WCL.">WCL Zone IDs</th>
              <th style={{ textAlign: 'center', padding: '4px 8px 8px 0', color: 'var(--text-muted)', fontWeight: 500, width: 90 }} title="Seed the Item DB from the latest (PTR) datamine build instead of the newest live build. Use while prepping a season before its patch launches.">Pre-release</th>
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
                  <td style={{ padding: '8px 8px 8px 0', whiteSpace: 'nowrap' }}>
                    <input
                      className="config-input config-input-narrow"
                      style={{ width: 78 }}
                      value={e.zoneIds ?? ''}
                      onChange={ev => setEdit(s.id, { zoneIds: ev.target.value })}
                      placeholder="e.g. 46"
                    />
                    <button
                      className="btn-secondary"
                      style={{ marginLeft: 6, fontSize: 12, padding: '3px 8px' }}
                      onClick={() => detectZones(s.id)}
                      disabled={rs.zonesLoading}
                      title="List the current expansion's raid zones from WCL to pick from"
                    >
                      {rs.zonesLoading ? '…' : 'Detect'}
                    </button>
                    {s.id === currentSeasonId && !String(e.zoneIds ?? '').trim() && (
                      <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 3 }} title="No WCL zone set for the current season — attendance/worn-BIS sync is paused until you set it (do this once the raid is live on WCL).">
                        ⚠ sync paused — no zone set
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!e.preRelease}
                      onChange={ev => setEdit(s.id, { preRelease: ev.target.checked })}
                      title="Pre-release: seed from the latest (PTR) build"
                    />
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', textAlign: 'center' }}>
                    {s.id === currentSeasonId
                      ? <span style={{ color: '#4caf50', fontWeight: 600 }}>● Current{s.is_current ? ' (manual)' : ' (auto)'}</span>
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

      {(() => {
        const openId = Object.keys(rowState).find(id => rowState[id]?.zonePicker);
        if (!openId) return null;
        const pick = rowState[openId].zonePicker;
        const close = () => setRow(Number(openId), { zonePicker: null });
        const use = (zoneId) => { setEdit(Number(openId), { zoneIds: String(zoneId) }); close(); };
        return (
          <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div onClick={ev => ev.stopPropagation()} className="card" style={{ maxWidth: 560, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
              <div className="card-title">
                WCL raid zones{pick.expansion ? ` — ${pick.expansion.name}` : ''}
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                Pick this season’s raid. WCL only lists tiers it has logs for, so a not-yet-live raid
                won’t appear — leave the zone blank until it does.
                {pick.raidInstanceNames?.length
                  ? <> This season’s seeded raid: <strong>{pick.raidInstanceNames.join(', ')}</strong>.</>
                  : null}
              </p>
              {pick.guess?.zoneId
                ? <p style={{ fontSize: 13, marginBottom: 12, color: 'var(--bis)' }}>
                    Best name match: <strong>{pick.guess.zoneName}</strong> (zone {pick.guess.zoneId}) — pre-selected below.
                  </p>
                : <p style={{ fontSize: 13, marginBottom: 12, color: '#fbbf24' }}>
                    No confident name match — none of the listed zones matched this season’s raid (expected before the tier is live on WCL).
                  </p>}
              {!pick.zones?.length
                ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No raid zones returned.</p>
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <tbody>
                      {pick.zones.map(z => {
                        const isGuess = String(z.id) === String(pick.guess?.zoneId ?? '');
                        return (
                          <tr key={z.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: isGuess ? 'rgba(76,175,80,0.08)' : 'transparent' }}>
                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{z.id}</td>
                            <td style={{ padding: '6px 8px' }}>
                              {z.name}
                              {z.frozen ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>(frozen)</span> : null}
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {z.encounters?.length ? `${z.encounters.length} boss${z.encounters.length !== 1 ? 'es' : ''}: ${z.encounters.slice(0, 4).join(', ')}${z.encounters.length > 4 ? '…' : ''}` : 'no bosses listed'}
                              </div>
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                              <button className="btn-secondary" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => use(z.id)}>Use</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              <div style={{ marginTop: 14, textAlign: 'right' }}>
                <button className="btn-secondary" onClick={close}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
