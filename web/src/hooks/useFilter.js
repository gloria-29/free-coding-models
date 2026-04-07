/**
 * @file web/src/hooks/useFilter.js
 * @description React hook for model filtering and sorting state.
 * 📖 Manages tier/status/provider/text filters + sort column/direction.
 * → useFilter
 */
import { useState, useMemo, useCallback } from 'react'
import { tierRank, verdictRank, parseSwe } from '../utils/ranks.js'
import { formatCtx } from '../utils/format.js'

export function useFilter(models) {
  const [filterTier, setFilterTier] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterProvider, setFilterProvider] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortColumn, setSortColumn] = useState('avg')
  const [sortDirection, setSortDirection] = useState('asc')

  const toggleSort = useCallback((col) => {
    setSortColumn((prevCol) => {
      if (prevCol === col) {
        setSortDirection((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortDirection('asc')
      }
      return col
    })
  }, [])

  const filtered = useMemo(() => {
    let result = [...models]

    if (filterTier !== 'all') result = result.filter((m) => m.tier === filterTier)
    if (filterStatus !== 'all') {
      result = result.filter((m) => {
        if (filterStatus === 'up') return m.status === 'up'
        if (filterStatus === 'down') return m.status === 'down' || m.status === 'timeout'
        if (filterStatus === 'pending') return m.status === 'pending'
        return true
      })
    }
    if (filterProvider !== 'all') result = result.filter((m) => m.providerKey === filterProvider)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (m) =>
          m.label.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          m.origin.toLowerCase().includes(q) ||
          m.tier.toLowerCase().includes(q) ||
          (m.verdict || '').toLowerCase().includes(q)
      )
    }

    result.sort((a, b) => {
      let cmp = 0
      const col = sortColumn
      if (col === 'idx') cmp = a.idx - b.idx
      else if (col === 'tier') cmp = tierRank(a.tier) - tierRank(b.tier)
      else if (col === 'label') cmp = a.label.localeCompare(b.label)
      else if (col === 'origin') cmp = a.origin.localeCompare(b.origin)
      else if (col === 'sweScore') cmp = parseSwe(a.sweScore) - parseSwe(b.sweScore)
      else if (col === 'ctx') cmp = formatCtx(a.ctx) - formatCtx(b.ctx)
      else if (col === 'latestPing') cmp = (a.latestPing ?? Infinity) - (b.latestPing ?? Infinity)
      else if (col === 'avg') cmp = (a.avg === Infinity ? 99999 : a.avg) - (b.avg === Infinity ? 99999 : b.avg)
      else if (col === 'stability') cmp = (a.stability ?? -1) - (b.stability ?? -1)
      else if (col === 'verdict') cmp = verdictRank(a.verdict) - verdictRank(b.verdict)
      else if (col === 'uptime') cmp = (a.uptime ?? 0) - (b.uptime ?? 0)
      return sortDirection === 'asc' ? cmp : -cmp
    })

    return result
  }, [models, filterTier, filterStatus, filterProvider, searchQuery, sortColumn, sortDirection])

  return {
    filtered,
    filterTier, setFilterTier,
    filterStatus, setFilterStatus,
    filterProvider, setFilterProvider,
    searchQuery, setSearchQuery,
    sortColumn, sortDirection, toggleSort,
  }
}
