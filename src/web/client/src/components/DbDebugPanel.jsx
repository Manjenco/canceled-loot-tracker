/**
 * DbDebugPanel — DB read statistics overlay.
 *
 * Probes /api/debug/db-stats on mount. If the endpoint returns 404
 * (DB_DEBUG not set on the server), the component renders nothing at all.
 * When enabled, renders a collapsible panel fixed to the bottom-right corner
 * showing per-table cache hit/miss counts and total rows read.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiPath } from '../lib/api.js';

const POLL_MS = 3000;

export default function DbDebugPanel() {
  const [available, setAvailable]   = useState(null); // null=probing, false=disabled, true=enabled
  const [open, setOpen]             = useState(false);
  const [stats, setStats]           = useState(null);
  const [resetting, setResetting]   = useState(false);
  const pollRef                     = useRef(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(apiPath('/api/debug/db-stats'), { credentials: 'include' });
      if (res.status === 404) { setAvailable(false); return; }
      const data = await res.json();
      setAvailable(true);
      setStats(data);
    } catch {
      // network error — don't hide, just leave stale data
    }
  }, []);

  // Probe on mount
  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Poll while panel is open
  useEffect(() => {
    if (!open || !available) return;
    pollRef.current = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [open, available, fetchStats]);

  async function reset() {
    setResetting(true);
    try {
      const res = await fetch(apiPath('/api/debug/db-stats/reset'), {
        method: 'POST', credentials: 'include',
      });
      const data = await res.json();
      setStats(data);
    } finally {
      setResetting(false);
    }
  }

  if (available === false || available === null) return null;

  const totalOps  = (stats?.cacheHits ?? 0) + (stats?.cacheMisses ?? 0);
  const hitRate   = totalOps ? Math.round((stats.cacheHits / totalOps) * 100) : 0;
  const rows      = stats?.totalRowsRead ?? 0;
  const tables    = stats?.tables ?? {};
  const resetAge  = stats?.resetAt ? Math.round((Date.now() - stats.resetAt) / 1000) : 0;

  return (
    <div className="db-debug-panel" data-open={open}>
      {/* Toggle badge */}
      <button
        className="db-debug-toggle"
        onClick={() => { setOpen(o => !o); if (!open) fetchStats(); }}
        title="DB read debug panel"
      >
        🔍 DB {rows.toLocaleString()} rows {open ? '▲' : '▼'}
      </button>

      {open && (
        <div className="db-debug-body">
          <div className="db-debug-header">
            <div className="db-debug-summary">
              <span className="db-debug-stat"><strong>{rows.toLocaleString()}</strong> rows read</span>
              <span className="db-debug-stat"><strong>{hitRate}%</strong> cache hit rate</span>
              <span className="db-debug-stat db-debug-age">reset {resetAge}s ago</span>
            </div>
            <button className="db-debug-reset" onClick={reset} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset'}
            </button>
          </div>

          <table className="db-debug-table">
            <thead>
              <tr>
                <th>Key</th>
                <th title="Rows read from DB (cache misses only)">Rows</th>
                <th title="Number of DB queries (cache misses)">DB hits</th>
                <th title="Served from cache">Cache hits</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(tables).map(([key, t]) => (
                <tr key={key}>
                  <td className="db-debug-key">{key}</td>
                  <td className="db-debug-num">{t.rows.toLocaleString()}</td>
                  <td className="db-debug-num db-debug-miss">{t.misses}</td>
                  <td className="db-debug-num db-debug-hit">{t.hits}</td>
                </tr>
              ))}
              {!Object.keys(tables).length && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No reads recorded yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
