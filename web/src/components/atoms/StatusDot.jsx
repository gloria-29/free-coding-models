/**
 * @file web/src/components/atoms/StatusDot.jsx
 * @description Renders a colored status indicator dot (green=up, red=down, gray=pending).
 */
import styles from './StatusDot.module.css'

export default function StatusDot({ status }) {
  const cls = status === 'up' ? styles.up : status === 'timeout' ? styles.timeout : status === 'down' ? styles.down : styles.pending
  return <span className={`${styles.dot} ${cls}`} />
}
