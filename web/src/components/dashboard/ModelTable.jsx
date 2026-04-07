/**
 * @file web/src/components/dashboard/ModelTable.jsx
 * @description Main data table with medal rankings for top 3 fastest models.
 */
import { useMemo } from 'react'
import TierBadge from '../atoms/TierBadge.jsx'
import StatusDot from '../atoms/StatusDot.jsx'
import VerdictBadge from '../atoms/VerdictBadge.jsx'
import StabilityCell from '../atoms/StabilityCell.jsx'
import Sparkline from '../atoms/Sparkline.jsx'
import { pingClass } from '../../utils/format.js'
import { sweClass } from '../../utils/ranks.js'
import styles from './ModelTable.module.css'

export default function ModelTable({ filtered, onSelectModel }) {
  const top3Ids = useMemo(() => {
    const online = filtered.filter(m => m.status === 'up' && m.avg !== Infinity)
    return new Set([...online].sort((a, b) => a.avg - b.avg).slice(0, 3).map(m => m.modelId))
  }, [filtered])

  const top3Arr = useMemo(() => {
    const online = filtered.filter(m => m.status === 'up' && m.avg !== Infinity)
    return [...online].sort((a, b) => a.avg - b.avg).slice(0, 3).map(m => m.modelId)
  }, [filtered])

  if (filtered.length === 0) {
    return <div className={styles.empty}>No models match your filters</div>
  }

  return (
    <div className={styles.container}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>#</th>
            <th className={styles.th}>Tier</th>
            <th className={styles.th}>Model</th>
            <th className={styles.th}>Provider</th>
            <th className={styles.th}>SWE %</th>
            <th className={styles.th}>Ctx</th>
            <th className={styles.th}>Ping</th>
            <th className={styles.th}>Avg</th>
            <th className={styles.th}>Stability</th>
            <th className={styles.th}>Verdict</th>
            <th className={styles.th}>Uptime</th>
            <th className={styles.th}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((m, i) => {
            const rankIdx = top3Arr.indexOf(m.modelId)
            const medal = rankIdx === 0 ? '🥇' : rankIdx === 1 ? '🥈' : rankIdx === 2 ? '🥉' : ''
            const rowCls = rankIdx >= 0 ? styles[`rank${rankIdx + 1}`] : ''
            return (
              <tr key={m.modelId} className={rowCls} onClick={() => onSelectModel(m)}>
                <td className={styles.tdRank}>{medal || (i + 1)}</td>
                <td><TierBadge tier={m.tier} /></td>
                <td>
                  <div className={styles.modelCell}>
                    <StatusDot status={m.status} />
                    <span className={styles.modelName}>{m.label}</span>
                    {!m.hasApiKey && !m.cliOnly && <span className={styles.noKey}>🔑 NO KEY</span>}
                    <div className={styles.modelId}>{m.modelId}</div>
                  </div>
                </td>
                <td><span className={styles.providerPill}>{m.origin}</span></td>
                <td className={`${styles.swe} ${styles[sweClass(m.sweScore)]}`}>{m.sweScore || '—'}</td>
                <td className={styles.ctx}>{m.ctx || '—'}</td>
                <td className={`${styles.ping} ${styles[pingClass(m.latestPing)]}`}>
                  {m.latestPing == null ? '—' : m.latestCode === '429' ? '429' : m.latestCode === '000' ? 'TIMEOUT' : `${m.latestPing}ms`}
                </td>
                <td className={`${styles.ping} ${styles[pingClass(m.avg)]}`}>
                  {m.avg == null || m.avg === Infinity || m.avg > 99000 ? '—' : `${m.avg}ms`}
                </td>
                <td><StabilityCell score={m.stability} /></td>
                <td><VerdictBadge verdict={m.verdict} httpCode={m.httpCode} /></td>
                <td className={styles.uptime}>{m.uptime > 0 ? `${m.uptime}%` : '—'}</td>
                <td><Sparkline history={m.pingHistory} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
