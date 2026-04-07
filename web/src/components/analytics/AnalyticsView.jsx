/**
 * @file web/src/components/analytics/AnalyticsView.jsx
 * @description Analytics dashboard page showing provider health, fastest models leaderboard, and tier distribution.
 * 📖 Purely derived from the `models` SSE data. No API calls needed beyond the live model feed.
 * @functions AnalyticsView → renders the three analytics cards
 */
import { useMemo } from 'react'
import TierBadge from '../atoms/TierBadge.jsx'
import styles from './AnalyticsView.module.css'

const TIER_COLORS = {
  'S+': '#ffd700', S: '#ff8c00', 'A+': '#00c8ff', A: '#3ddc84',
  'A-': '#7ecf7e', 'B+': '#a8a8c8', B: '#808098', C: '#606078',
}
const TIERS = ['S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']

export default function AnalyticsView({ models }) {
  const providerHealth = useMemo(() => {
    const map = {}
    models.forEach((m) => {
      if (!map[m.origin]) map[m.origin] = { total: 0, online: 0, key: m.providerKey }
      map[m.origin].total++
      if (m.status === 'up') map[m.origin].online++
    })
    return Object.entries(map).sort((a, b) => (b[1].online / b[1].total) - (a[1].online / a[1].total))
  }, [models])

  const leaderboard = useMemo(() => {
    const online = models.filter((m) => m.status === 'up' && m.avg !== Infinity && m.avg < 99000)
    return [...online].sort((a, b) => a.avg - b.avg).slice(0, 10)
  }, [models])

  const tierCounts = useMemo(() => {
    const counts = {}
    models.forEach((m) => { counts[m.tier] = (counts[m.tier] || 0) + 1 })
    const maxCount = Math.max(...Object.values(counts), 1)
    return TIERS.map((t) => ({ tier: t, count: counts[t] || 0, pct: ((counts[t] || 0) / maxCount) * 100 }))
  }, [models])

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>📊 Analytics</h1>
        <p className={styles.pageSubtitle}>Real-time insights across all providers and models</p>
      </div>

      <div className={styles.grid}>
        <div className={`${styles.card} ${styles.cardWide}`}>
          <h3 className={styles.cardTitle}>Provider Health Overview</h3>
          <div className={styles.cardBody}>
            {providerHealth.length === 0 ? (
              <div className={styles.empty}>Waiting for data...</div>
            ) : (
              providerHealth.map(([name, data]) => {
                const pct = data.total > 0 ? Math.round((data.online / data.total) * 100) : 0
                const pctCls = pct > 70 ? styles.pctFast : pct > 30 ? styles.pctMedium : styles.pctSlow
                return (
                  <div key={name} className={styles.healthItem}>
                    <span className={styles.healthName}>{name}</span>
                    <div className={styles.healthBar}>
                      <div className={styles.healthFill} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={`${styles.healthPct} ${pctCls}`}>{pct}%</span>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className={styles.card}>
          <h3 className={styles.cardTitle}>🏆 Fastest Models</h3>
          <div className={styles.cardBody}>
            {leaderboard.length === 0 ? (
              <div className={styles.empty}>Waiting for ping data...</div>
            ) : (
              leaderboard.map((m, i) => {
                const rankCls = i < 3 ? styles[`rank${i + 1}`] : ''
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1)
                return (
                  <div key={m.modelId} className={styles.leaderItem}>
                    <div className={`${styles.leaderRank} ${rankCls}`}>{medal}</div>
                    <span className={styles.leaderName}>{m.label}</span>
                    <span className={styles.leaderLatency}>{m.avg}ms</span>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className={styles.card}>
          <h3 className={styles.cardTitle}>Tier Distribution</h3>
          <div className={styles.cardBody}>
            {tierCounts.map(({ tier, count, pct }) => (
              <div key={tier} className={styles.tierItem}>
                <div className={styles.tierBadge}><TierBadge tier={tier} /></div>
                <div className={styles.tierBar}>
                  <div className={styles.tierFill} style={{ width: `${pct}%`, background: TIER_COLORS[tier] }} />
                </div>
                <span className={styles.tierCount}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
