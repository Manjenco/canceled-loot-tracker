/**
 * AdminDefaultBis — Officer page for editing Default Raid BIS.
 *
 * Shows all 16 slots for the selected spec and source. Officers can override
 * both Overall BIS and Raid BIS per slot independently on top of the seeded source.
 *
 * Auto-inferred Raid BIS slots (tier, catalyst, raid-sourced items) show a locked
 * badge by default. Editing Overall BIS on such a slot unlocks the Raid BIS field.
 *
 * The source bar lets officers switch between available BIS sources to compare
 * lists, and set one as the preferred default for the spec.
 */

import { apiPath } from '../lib/api.js';
import { useState, useEffect, useCallback } from 'react';
import ItemLink   from '../components/ItemLink.jsx';
import ItemSelect from '../components/ItemSelect.jsx';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

export default function AdminDefaultBis() {
  const [classSpecs, setClassSpecs]         = useState(null);
  const [selectedSpec, setSelected]         = useState('');
  const [rows, setRows]                     = useState([]);
  const [availableSources, setAvailable]    = useState([]);
  const [preferredSource, setPreferred]     = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [edits, setEdits]                   = useState({});   // slot → { raidBis?, raidBisItemId?, trueBis?, trueBisItemId? }
  const [unlockedAutoSlots, setUnlockedAutoSlots] = useState(new Set()); // auto slots unlocked by Overall BIS edit
  const [loadingSpec, setLoadingSpec]       = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [savingSource, setSavingSource]     = useState(false);
  const [saveMsg, setSaveMsg]               = useState(null);
  const [error, setError]                   = useState(null);

  // Load spec list once
  useEffect(() => {
    fetch(apiPath('/api/admin/specs'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setClassSpecs)
      .catch(() => setError('Failed to load spec list'));
  }, []);

  // Load rows for a spec + optional source override
  const loadSpec = useCallback(async (spec, source) => {
    if (!spec) return;
    setLoadingSpec(true);
    setEdits({});
    setUnlockedAutoSlots(new Set());
    setSaveMsg(null);
    setError(null);
    try {
      const params = new URLSearchParams({ spec });
      if (source) params.set('source', source);
      const res = await fetch(
        apiPath(`/api/admin/default-bis?${params}`),
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      setRows(data.rows ?? []);
      setAvailable(data.availableSources ?? []);
      setPreferred(data.preferredSource ?? '');
      // Keep selectedSource in sync with what the server actually returned
      setSelectedSource(data.source ?? '');
    } catch {
      setError('Failed to load BIS data for this spec');
    } finally {
      setLoadingSpec(false);
    }
  }, []);

  // When spec changes, reset source so server picks the preferred one
  useEffect(() => {
    setSelectedSource('');
    setAvailable([]);
    setPreferred('');
    loadSpec(selectedSpec, '');
  }, [selectedSpec, loadSpec]);

  const handleSourceChange = (source) => {
    if (source === selectedSource) return;
    loadSpec(selectedSpec, source);
  };

  const handleSetDefault = async () => {
    if (!selectedSpec || !selectedSource || selectedSource === preferredSource) return;
    setSavingSource(true);
    setSaveMsg(null);
    try {
      const res = await fetch(apiPath('/api/admin/spec-bis-source'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ spec: selectedSpec, source: selectedSource }),
      });
      if (!res.ok) throw new Error(res.status);
      setPreferred(selectedSource);
      setSaveMsg(`Default source set to "${selectedSource}".`);
    } catch {
      setError('Failed to save preferred source.');
    } finally {
      setSavingSource(false);
    }
  };

  const handleEditOverall = (slot, trueBis, trueBisItemId = '') => {
    const row = rowBySlot[slot];
    const isSentinel   = trueBis === '<Tier>' || trueBis === '<Catalyst>';
    const overallItem  = (row?.overallOptions ?? []).find(o => o.name === trueBis);
    const wouldAutoInfer = isSentinel || overallItem?.sourceType === 'Raid';

    setEdits(prev => {
      const prevSlot = { ...prev[slot] };
      prevSlot.trueBis      = trueBis;
      prevSlot.trueBisItemId = trueBisItemId;
      if (wouldAutoInfer) {
        prevSlot.raidBis        = trueBis;
        prevSlot.raidBisItemId  = trueBisItemId;
        prevSlot.raidBisIsAuto  = true;
      } else if (prevSlot.raidBisIsAuto) {
        delete prevSlot.raidBis;
        delete prevSlot.raidBisItemId;
        delete prevSlot.raidBisIsAuto;
      }
      return { ...prev, [slot]: prevSlot };
    });

    if (wouldAutoInfer) {
      // Keep this slot showing Auto (clear from unlocked set)
      setUnlockedAutoSlots(prev => { const next = new Set(prev); next.delete(slot); return next; });
    } else if (row?.raidBisAuto) {
      // Non-raid Overall BIS on a previously-auto Raid BIS slot → unlock it
      setUnlockedAutoSlots(prev => new Set([...prev, slot]));
    }
    setSaveMsg(null);
  };

  const handleEditRaid = (slot, raidBis, raidBisItemId = '') => {
    setEdits(prev => ({ ...prev, [slot]: { ...prev[slot], raidBis, raidBisItemId } }));
    setSaveMsg(null);
  };

  const handleSave = async () => {
    if (!selectedSpec || !rows.length || !selectedSource) return;

    const updates = Object.entries(edits)
      .filter(([, v]) => v !== undefined)
      .map(([slot, v]) => ({
        slot,
        ...(v.raidBis !== undefined ? { raidBis: v.raidBis, raidBisItemId: v.raidBisItemId ?? '' } : {}),
        ...(v.trueBis !== undefined ? { trueBis: v.trueBis, trueBisItemId: v.trueBisItemId ?? '' } : {}),
      }));

    if (!updates.length) { setSaveMsg('No changes to save.'); return; }

    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(apiPath('/api/admin/default-bis'), {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ spec: selectedSpec, source: selectedSource, updates }),
      });
      if (!res.ok) throw new Error(res.status);
      setSaveMsg(`Saved ${updates.length} slot${updates.length !== 1 ? 's' : ''}.`);
      setEdits({});
      await loadSpec(selectedSpec, selectedSource);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const rowBySlot  = Object.fromEntries((rows ?? []).map(r => [r.slot, r]));
  const dirtyCount = Object.values(edits).filter(v => v !== undefined).length;
  const isDefault  = selectedSource === preferredSource;

  return (
    <div className="admin-default-bis">
      <div className="page-header">
        <h2 className="page-title">Default Raid BIS</h2>
        <p className="page-sub">
          Select a source as the base, then override individual slots as needed.
          Editing Overall BIS on an auto-inferred slot also unlocks Raid BIS for that slot.
        </p>
      </div>

      {/* Spec selector */}
      <div className="card spec-selector-card">
        <label className="field-label" htmlFor="spec-select">Spec</label>
        <select
          id="spec-select"
          className="select"
          value={selectedSpec}
          onChange={e => setSelected(e.target.value)}
        >
          <option value="">— Select a spec —</option>
          {classSpecs && Object.entries(classSpecs).map(([cls, specs]) => (
            <optgroup key={cls} label={cls}>
              {specs.map(s => <option key={s} value={s}>{s}</option>)}
            </optgroup>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      {/* Source tabs — shown once we know what sources exist for this spec */}
      {selectedSpec && !loadingSpec && availableSources.length > 0 && (
        <div className="card source-selector-card">
          <span className="field-label">Source</span>
          <div className="source-tabs">
            {availableSources.map(src => (
              <button
                key={src}
                type="button"
                className={`source-tab${selectedSource === src ? ' source-tab-active' : ''}`}
                onClick={() => handleSourceChange(src)}
              >
                {src}
                {src === preferredSource && (
                  <span className="badge badge-default">Default</span>
                )}
              </button>
            ))}
          </div>
          {!isDefault && selectedSource && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={handleSetDefault}
              disabled={savingSource}
            >
              {savingSource ? 'Saving…' : `Set "${selectedSource}" as Default`}
            </button>
          )}
        </div>
      )}

      {selectedSpec && !loadingSpec && rows.length > 0 && (
        <>
          <div className="card">
            <table className="bis-table admin-bis-table">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Overall BIS</th>
                  <th>Raid BIS</th>
                  <th className="admin-source-col">Source</th>
                </tr>
              </thead>
              <tbody>
                {ALL_SLOTS.map(slot => {
                  const row = rowBySlot[slot];
                  if (!row) return (
                    <tr key={slot} className="bis-row-empty">
                      <td className="bis-slot">{slot}</td>
                      <td colSpan={3} className="text-muted">—</td>
                    </tr>
                  );

                  const isAuto        = row.raidBisAuto === true;
                  const isAutoUnlocked = unlockedAutoSlots.has(slot);
                  const editVal       = edits[slot];
                  const currentOverall = editVal?.trueBis !== undefined ? editVal.trueBis : (row.trueBis ?? '');
                  const currentRaid    = editVal?.raidBis !== undefined ? editVal.raidBis : (row.raidBis ?? '');
                  const options        = row.options ?? [];

                  const isDirty = editVal !== undefined && (
                    (editVal.trueBis !== undefined && editVal.trueBis !== row.trueBis) ||
                    (editVal.raidBis !== undefined && editVal.raidBis !== row.raidBis)
                  );

                  return (
                    <tr key={slot} className={isDirty ? 'bis-row-dirty' : ''}>
                      <td className="bis-slot">{slot}</td>
                      <td>
                        <ItemSelect
                          value={currentOverall}
                          options={row.overallOptions ?? []}
                          sentinels={[
                            ...(row.hasTier     ? [{ value: '<Tier>',     label: '<Tier>'     }] : []),
                            ...(row.hasCatalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
                            { value: '<Crafted>', label: '<Crafted>' },
                          ]}
                          defaultValue={row.trueBisSeed ?? ''}
                          pendingValue={currentOverall !== (row.trueBisSeed ?? '') ? currentOverall : ''}
                          empty={!currentOverall}
                          onChange={(name, itemId) => handleEditOverall(slot, name, itemId)}
                        />
                      </td>
                      <td>
                        {(() => {
                          const showAuto = editVal?.raidBisIsAuto === true || (isAuto && !isAutoUnlocked);
                          const autoName   = editVal?.raidBisIsAuto ? editVal.raidBis        : row.raidBis;
                          const autoItemId = editVal?.raidBisIsAuto ? editVal.raidBisItemId  : row.raidBisItemId;
                          return showAuto ? (
                            <span className="raid-bis-auto">
                              <ItemLink name={autoName} itemId={autoItemId} />
                              <span className="badge badge-auto">Auto</span>
                            </span>
                          ) : (
                            <ItemSelect
                              value={currentRaid}
                              options={options}
                              sentinels={[
                                ...(row.hasCatalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
                              ]}
                              defaultValue={row.raidBisSeed ?? ''}
                              pendingValue={currentRaid !== (row.raidBisSeed ?? '') ? currentRaid : ''}
                              empty={!currentRaid}
                              onChange={(name, itemId) => handleEditRaid(slot, name, itemId)}
                            />
                          );
                        })()}
                      </td>
                      <td className="admin-source-col text-muted">{row.source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="admin-save-bar">
            {saveMsg && <span className="save-msg">{saveMsg}</span>}
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving || dirtyCount === 0}
            >
              {saving ? 'Saving…' : `Save${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
            </button>
          </div>
        </>
      )}

      {selectedSpec && loadingSpec && (
        <div className="loading">Loading…</div>
      )}

      {selectedSpec && !loadingSpec && rows.length === 0 && !error && (
        <div className="card">
          <p className="empty">No Default BIS data found for this spec. Run the seed script first.</p>
        </div>
      )}
    </div>
  );
}
