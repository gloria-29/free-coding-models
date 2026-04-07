/**
 * @file web/src/hooks/useTheme.js
 * @description React hook for dark/light theme toggle.
 * 📖 Persists theme on <html data-theme="dark|light">. Reads initial from DOM.
 * → useTheme
 */
import { useState, useCallback, useEffect } from 'react'

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute('data-theme') || 'dark'
  })

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      return next
    })
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return { theme, toggle }
}
