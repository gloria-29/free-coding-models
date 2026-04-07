/**
 * @file web/src/components/dashboard/FilterBar.jsx
 * @description Filter controls for tier, status, provider, and search + live indicator.
 */
import styles from './FilterBar.module.css'

const TIERS = ['All', 'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'C']
const STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'up', label: 'Online' },
  { key: 'down', label: 'Offline' },
  { key: 'pending', label: 'Pending' },
]

export default function FilterBar({
  filterTier, setFilterTier,
  filterStatus, setFilterStatus,
  filterProvider, setFilterProvider,
  providers,
}) {
  return (
    <section className={styles.filters}>
      <div className={styles.group}>
        <label className={styles.filterLabel}>Tier</label>
        <div className={styles.tierRow}>
          {TIERS.map(t => (
            <button
              key={t}
              className={`${styles.tierBtn} ${filterTier === t ? styles.active : ''}`}
              onClick={() => setFilterTier(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.group}>
        <label className={styles.filterLabel}>Status</label>
        <div className={styles.tierRow}>
          {STATUSES.map(s => (
            <button
              key={s.key}
              className={`${styles.tierBtn} ${filterStatus === s.key ? styles.active : ''}`}
              onClick={() => setFilterStatus(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.group}>
        <label className={styles.filterLabel}>Provider</label>
        <select
          className={styles.providerSelect}
          value={filterProvider}
          onChange={e => setFilterProvider(e.target.value)}
        >
          <option value="all">All Providers</option>
          {providers.map(p => (
            <option key={p.key} value={p.key}>{p.name} ({p.count})</option>
          ))}
        </select>
      </div>
      <div className={styles.spacer} />
      <div className={styles.group}>
        <div className={styles.live}>
          <span className={styles.liveDot} />
          <span>LIVE</span>
        </div>
      </div>
    </section>
  )
}
