/**
 * @file web/src/components/dashboard/StatsBar.jsx
 * @description Stats cards row showing total models, online count, avg latency, fastest model, providers.
 */
import { useMemo } from 'react'
import styles from './StatsBar.module.css'

export default function StatsBar({ models }) {
  const stats = useMemo(() => {
    const total = models.length
    const online = models.filter(m => m.status === 'up').length
    const onlineWithPing = models.filter(m => m.status === 'up' && m.avg !== Infinity && m.avg < 99000)
    const avgLatency = onlineWithPing.length > 0
      ? Math.round(onlineWithPing.reduce((s, m) => s + m.avg, 0) / onlineWithPing.length)
      : null
    const fastest = [...onlineWithPing].sort((a, b) => a.avg - b.avg)[0]
    const providers = new Set(models.map(m => m.providerKey)).size
    return [
      { icon: '📊', value: total, label: 'Total Models' },
      { icon: '🟢', value: online, label: 'Online' },
      { icon: '⚡', value: avgLatency != null ? `${avgLatency}ms` : '—', label: 'Avg Latency' },
      { icon: '🏆', value: fastest ? fastest.label : '—', label: 'Fastest Model' },
      { icon: '🌐', value: providers, label: 'Providers' },
    ]
  }, [models])

  return (
    <section className={styles.statsBar}>
      {stats.map(s => (
        <div key={s.label} className={styles.card}>
          <div className={styles.icon}>{s.icon}</div>
          <div className={styles.body}>
            <div className={styles.value}>{s.value}</div>
            <div className={styles.label}>{s.label}</div>
          </div>
        </div>
      ))}
    </section>
  )
}
