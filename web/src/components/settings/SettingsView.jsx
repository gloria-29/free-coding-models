/**
 * @file web/src/components/settings/SettingsView.jsx
 * @description Full settings page for managing API keys and provider configurations.
 * 📖 Fetches config from /api/config, renders expandable provider cards with
 * key display (masked/revealed), save/delete/toggle actions, and search filter.
 * @functions SettingsView → main settings page component
 */
import { useState, useEffect, useCallback } from 'react'
import styles from './SettingsView.module.css'
import { maskKey } from '../../utils/format.js'

export default function SettingsView({ onToast }) {
  const [config, setConfig] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedCards, setExpandedCards] = useState(new Set())
  const [revealedKeys, setRevealedKeys] = useState(new Set())
  const [keyInputs, setKeyInputs] = useState({})

  const loadConfig = useCallback(async () => {
    try {
      const resp = await fetch('/api/config')
      const data = await resp.json()
      setConfig(data)
    } catch {
      onToast?.('Failed to load settings', 'error')
    }
  }, [onToast])

  useEffect(() => { loadConfig() }, [loadConfig])

  const toggleCard = (key) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = () => {
    if (!config) return
    setExpandedCards(new Set(Object.keys(config.providers)))
  }

  const collapseAll = () => setExpandedCards(new Set())

  const toggleRevealKey = async (key) => {
    if (revealedKeys.has(key)) {
      setRevealedKeys((prev) => { const n = new Set(prev); n.delete(key); return n })
      return
    }
    try {
      const resp = await fetch(`/api/key/${key}`)
      const data = await resp.json()
      if (data.key) {
        setRevealedKeys((prev) => new Set(prev).add(key))
      }
    } catch {
      onToast?.('Failed to reveal key', 'error')
    }
  }

  const copyKey = async (key) => {
    try {
      const resp = await fetch(`/api/key/${key}`)
      const data = await resp.json()
      if (data.key) {
        await navigator.clipboard.writeText(data.key)
        onToast?.('API key copied to clipboard', 'success')
      } else {
        onToast?.('No key to copy', 'warning')
      }
    } catch {
      onToast?.('Failed to copy key', 'error')
    }
  }

  const saveKey = async (key) => {
    const value = keyInputs[key]?.trim()
    if (!value) {
      onToast?.('Please enter an API key', 'warning')
      return
    }
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: { [key]: value } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`API key for ${key} saved successfully!`, 'success')
        setKeyInputs((prev) => ({ ...prev, [key]: '' }))
        setRevealedKeys((prev) => { const n = new Set(prev); n.delete(key); return n })
        await loadConfig()
        setExpandedCards((prev) => new Set(prev).add(key))
      } else {
        onToast?.(result.error || 'Failed to save', 'error')
      }
    } catch {
      onToast?.('Network error while saving', 'error')
    }
  }

  const deleteKey = async (key) => {
    if (!confirm(`Are you sure you want to delete the API key for "${key}"?`)) return
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: { [key]: '' } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`API key for ${key} deleted`, 'info')
        setRevealedKeys((prev) => { const n = new Set(prev); n.delete(key); return n })
        await loadConfig()
      } else {
        onToast?.(result.error || 'Failed to delete', 'error')
      }
    } catch {
      onToast?.('Network error while deleting', 'error')
    }
  }

  const toggleProvider = async (key, enabled) => {
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [key]: { enabled } } }),
      })
      const result = await resp.json()
      if (result.success) {
        onToast?.(`${key} ${enabled ? 'enabled' : 'disabled'}`, 'success')
      } else {
        onToast?.(result.error || 'Failed to toggle', 'error')
      }
    } catch {
      onToast?.('Network error', 'error')
    }
  }

  if (!config) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading settings...</div>
      </div>
    )
  }

  const entries = Object.entries(config.providers)
    .filter(([, p]) => {
      if (!searchQuery) return true
      const q = searchQuery.toLowerCase()
      return p.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a[1].name.localeCompare(b[1].name))

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>⚙️ Provider Settings</h1>
        <p className={styles.pageSubtitle}>
          Manage your API keys and provider configurations. Keys are stored locally in{' '}
          <code>~/.free-coding-models.json</code>
        </p>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarSearch}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search providers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.toolbarBtn} onClick={expandAll}>Expand All</button>
          <button className={styles.toolbarBtn} onClick={collapseAll}>Collapse All</button>
        </div>
      </div>

      <div className={styles.providers}>
        {entries.map(([key, p]) => {
          const isExpanded = expandedCards.has(key)
          const isRevealed = revealedKeys.has(key)

          return (
            <div key={key} className={`${styles.card} ${isExpanded ? styles.cardExpanded : ''}`}>
              <div className={styles.cardHeader} onClick={() => toggleCard(key)}>
                <div className={styles.cardIcon}>🔌</div>
                <div className={styles.cardInfo}>
                  <div className={styles.cardName}>{p.name}</div>
                  <div className={styles.cardMeta}>{p.modelCount} models · {key}</div>
                </div>
                <span className={`${styles.cardStatus} ${p.hasKey ? styles.statusConfigured : styles.statusMissing}`}>
                  {p.hasKey ? '✅ Active' : '🔑 No Key'}
                </span>
                <span className={`${styles.toggleIcon} ${isExpanded ? styles.toggleIconExpanded : ''}`}>▼</span>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.cardContent}>
                  {p.hasKey && (
                    <div className={styles.keyGroup}>
                      <label className={styles.keyLabel}>Current API Key</label>
                      <div className={styles.keyDisplay}>
                        <span className={styles.keyDisplayValue}>
                          {isRevealed ? (p.maskedKey || '••••••••') : maskKey(p.maskedKey || '')}
                        </span>
                        <div className={styles.keyDisplayActions}>
                          <button className={styles.actionBtn} onClick={() => toggleRevealKey(key)} title={isRevealed ? 'Hide' : 'Reveal'}>
                            {isRevealed ? '🙈' : '👁️'}
                          </button>
                          <button className={styles.actionBtn} onClick={() => copyKey(key)} title="Copy">📋</button>
                          <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => deleteKey(key)} title="Delete Key">🗑️</button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className={styles.keyGroup}>
                    <label className={styles.keyLabel}>{p.hasKey ? 'Update API Key' : 'Add API Key'}</label>
                    <div className={styles.keyInputRow}>
                      <input
                        type="password"
                        className={styles.keyInput}
                        placeholder="Enter your API key..."
                        value={keyInputs[key] || ''}
                        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                        autoComplete="off"
                      />
                      <button className={styles.saveBtn} onClick={() => saveKey(key)}>
                        {p.hasKey ? 'Update' : 'Save'}
                      </button>
                    </div>
                  </div>

                  <div className={styles.enabledRow}>
                    <span className={styles.enabledLabel}>Provider Enabled</span>
                    <label className={styles.toggleSwitch}>
                      <input
                        type="checkbox"
                        defaultChecked={p.enabled !== false}
                        onChange={(e) => toggleProvider(key, e.target.checked)}
                      />
                      <span className={styles.toggleSlider} />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
