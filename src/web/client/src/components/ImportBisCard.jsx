/**
 * ImportBisCard — Officer tool to parse a public BIS guide (Wowhead / Maxroll)
 * and import it as the base Default BIS seed for the selected spec + source.
 *
 * Flow: pick source → (optionally) enter the guide URL → Parse. The server fetches
 * and parses the page; if the fetch is blocked it asks for the page source to be
 * pasted instead. Parsed rows land in an editable review table (reusing the same
 * ItemSelect as the editor) where the officer fixes any unmatched items, then Imports.
 *
 * Importing writes base default_bis rows for the current season; the per-slot
 * override editor below still layers on top for fine-tuning.
 */

import { useState } from 'react';
import { apiPath } from '../lib/api.js';
import ItemSelect from './ItemSelect.jsx';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const SOURCES = ['Wowhead', 'Maxroll'];

const STATUS_BADGE = {
  unmatched: { cls: 'badge-warn',  label: 'not in Item DB' },
  not_found: { cls: 'badge-error', label: 'not found' },
};

export default function ImportBisCard({ spec, onImported }) {
  const [open, setOpen]         = useState(false);
  const [source, setSource]     = useState('Wowhead');
  const [url, setUrl]           = useState('');
  const [html, setHtml]         = useState('');
  const [showPaste, setShowPaste] = useState(true);   // paste is the reliable default; URL fetch is bot-blocked
  const [parsing, setParsing]   = useState(false);
  const [importing, setImporting] = useState(false);
  const [rows, setRows]         = useState(null);   // null until parsed
  const [parsedCount, setParsedCount] = useState(0);
  const [warnings, setWarnings] = useState([]);
  const [error, setError]       = useState(null);
  const [info, setInfo]         = useState(null);

  const reset = () => {
    setRows(null); setError(null); setInfo(null); setParsedCount(0); setWarnings([]);
    setHtml(''); setShowPaste(true);
  };

  const rowBySlot = rows ? Object.fromEntries(rows.map(r => [r.slot, r])) : {};

  const doParse = async () => {
    if (!spec) return;
    setParsing(true); setError(null); setInfo(null); setRows(null); setWarnings([]);
    try {
      const res = await fetch(apiPath('/api/admin/default-bis/parse'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, source, url: url.trim() || undefined, html: showPaste ? html : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Parse failed (${res.status})`);
        if (data.needsPaste) setShowPaste(true);
        if (data.suggestedUrl && !url.trim()) setUrl(data.suggestedUrl);
        return;
      }
      setRows(data.rows ?? []);
      setParsedCount(data.parsedCount ?? 0);
      setWarnings(data.warnings ?? []);
      if (data.url && !url.trim()) setUrl(data.url);
      setInfo(`Parsed ${data.parsedCount} slot${data.parsedCount === 1 ? '' : 's'} from ${data.source}${data.fetched ? ' (fetched)' : ' (pasted)'}. Review and import below.`);
    } catch {
      setError('Network error while parsing.');
    } finally {
      setParsing(false);
    }
  };

  const editRow = (slot, field, name, itemId) => {
    setRows(prev => prev.map(r => r.slot === slot
      ? { ...r, [field]: name, [`${field}ItemId`]: itemId ?? '', status: 'ok' }
      : r));
  };

  const doImport = async () => {
    if (!rows?.length) return;
    const payload = rows
      .filter(r => r.trueBis || r.trueBisItemId)
      .map(r => ({
        slot: r.slot,
        trueBis: r.trueBis ?? '', trueBisItemId: r.trueBisItemId ?? '',
        raidBis: r.raidBis ?? '', raidBisItemId: r.raidBisItemId ?? '',
      }));
    if (!payload.length) { setError('Nothing to import — all slots are empty.'); return; }

    setImporting(true); setError(null); setInfo(null);
    try {
      const res = await fetch(apiPath('/api/admin/default-bis/import'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, source, rows: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Import failed (${res.status})`); return; }
      reset();
      setInfo(`Imported ${data.written} slot${data.written === 1 ? '' : 's'} as "${source}" default BIS.`);
      onImported?.(source);
    } catch {
      setError('Network error while importing.');
    } finally {
      setImporting(false);
    }
  };

  if (!spec) return null;

  return (
    <div className="card import-bis-card">
      <button
        type="button"
        className="import-bis-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="import-bis-toggle-icon" aria-hidden>{open ? '▾' : '▸'}</span>
        Import from guide
      </button>

      {open && (
        <div className="import-bis-body">
          <div className="import-bis-controls">
            <label className="field-label" htmlFor="bis-source">Source</label>
            <select
              id="bis-source"
              className="select"
              value={source}
              onChange={e => { setSource(e.target.value); reset(); }}
            >
              {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            {showPaste ? (
              <>
                <p className="import-bis-hint">
                  Open the {source} guide for this spec in your browser, view the page
                  source (<kbd>Ctrl</kbd>+<kbd>U</kbd>), select all (<kbd>Ctrl</kbd>+<kbd>A</kbd>),
                  copy, and paste it below.
                </p>
                <textarea
                  className="input import-bis-paste"
                  rows={6}
                  placeholder="Paste the full page source here…"
                  value={html}
                  onChange={e => setHtml(e.target.value)}
                />
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="bis-url">Guide URL</label>
                <input
                  id="bis-url"
                  className="input"
                  type="url"
                  placeholder="Leave blank to use the default URL for this spec"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                />
              </>
            )}

            <div className="import-bis-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={doParse}
                disabled={parsing || (showPaste && !html.trim())}
              >
                {parsing ? 'Parsing…' : showPaste ? 'Parse pasted source' : 'Fetch & parse'}
              </button>
              <button
                type="button"
                className="btn-link"
                onClick={() => setShowPaste(s => !s)}
              >
                {showPaste ? 'Try fetching by URL instead' : 'Paste page source instead'}
              </button>
            </div>
          </div>

          {error && <p className="error">{error}</p>}
          {info  && <p className="save-msg">{info}</p>}

          {warnings.length > 0 && (
            <ul className="import-bis-warnings">
              {warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}

          {rows && rows.length > 0 && (
            <>
              <table className="bis-table admin-bis-table import-bis-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Overall BIS</th>
                    <th>Raid BIS</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_SLOTS.map(slot => {
                    const row = rowBySlot[slot];
                    if (!row) return null;
                    const badge = STATUS_BADGE[row.status];
                    const sentinelsOverall = [
                      ...(row.hasTier     ? [{ value: '<Tier>',     label: '<Tier>'     }] : []),
                      ...(row.hasCatalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
                      { value: '<Crafted>', label: '<Crafted>' },
                    ];
                    const sentinelsRaid = [
                      ...(row.hasTier     ? [{ value: '<Tier>',     label: '<Tier>'     }] : []),
                      ...(row.hasCatalyst ? [{ value: '<Catalyst>', label: '<Catalyst>' }] : []),
                    ];
                    return (
                      <tr key={slot}>
                        <td className="bis-slot">{slot}</td>
                        <td>
                          <ItemSelect
                            value={row.trueBis ?? ''}
                            options={row.overallOptions ?? []}
                            sentinels={sentinelsOverall}
                            empty={!row.trueBis}
                            onChange={(name, itemId) => editRow(slot, 'trueBis', name, itemId)}
                          />
                        </td>
                        <td>
                          <ItemSelect
                            value={row.raidBis ?? ''}
                            options={row.options ?? []}
                            sentinels={sentinelsRaid}
                            empty={!row.raidBis}
                            onChange={(name, itemId) => editRow(slot, 'raidBis', name, itemId)}
                          />
                        </td>
                        <td className="import-bis-status">
                          {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="import-bis-footer">
                <span className="text-muted">
                  Importing overwrites the existing "{source}" default for this spec.
                </span>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={doImport}
                  disabled={importing}
                >
                  {importing ? 'Importing…' : `Import as "${source}" default`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
