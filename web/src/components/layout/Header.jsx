/**
 * @file web/src/components/layout/Header.jsx
 * @description Top header bar with search, export button, settings shortcut, and theme toggle.
 */
import styles from './Header.module.css'

export default function Header({ searchQuery, onSearchChange, onToggleTheme, onOpenSettings, onOpenExport }) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⚡</span>
          <span className={styles.logoText}>free-coding-models</span>
        </div>
        <span className={styles.version}>v{__APP_VERSION__}</span>
      </div>
      <div className={styles.center}>
        <div className={styles.searchBar}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search models, providers, tiers..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
          />
          <kbd className={styles.kbd}>Ctrl+K</kbd>
        </div>
      </div>
      <div className={styles.right}>
        <button className={styles.iconBtn} onClick={onToggleTheme} title="Toggle theme">☽</button>
        <button className={styles.iconBtn} onClick={onOpenExport} title="Export Data">↓</button>
        <button className={styles.primaryBtn} onClick={onOpenSettings}>⚙ Settings</button>
      </div>
    </header>
  )
}
