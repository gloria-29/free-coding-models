/**
 * @file web/src/components/atoms/VerdictBadge.jsx
 * @description Renders a verdict badge (Perfect, Normal, Slow, etc.) with styled pill.
 */
import { verdictCls } from '../../utils/ranks.js'
import styles from './VerdictBadge.module.css'

export default function VerdictBadge({ verdict, httpCode }) {
  if (!verdict) return <span className={`${styles.badge} ${styles.pending}`}>Pending</span>
  if (httpCode === '429') return <span className={`${styles.badge} ${styles.ratelimited}`}>⚠️ Rate Limited</span>
  const cls = verdictCls(verdict)
  return <span className={`${styles.badge} ${styles[cls]}`}>{verdict}</span>
}
