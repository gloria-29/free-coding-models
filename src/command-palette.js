/**
 * @file command-palette.js
 * @description Command palette registry and fuzzy search helpers for the main TUI.
 *          Now supports hierarchical categories with expandable/collapsible groups.
 *
 * @functions
 *   → `buildCommandPaletteTree` — builds the hierarchical command tree with categories and subcategories
 *   → `flattenCommandTree` — converts tree to flat list for filtering (respects expansion state)
 *   → `fuzzyMatchCommand` — scores a query against one string and returns match positions
 *   → `filterCommandPaletteEntries` — returns sorted command matches for a query
 *
 * @exports { buildCommandPaletteTree, flattenCommandTree, fuzzyMatchCommand, filterCommandPaletteEntries }
 *
 * @see src/key-handler.js
 * @see src/overlays.js
 */

// 📖 Hierarchical command tree with categories and subcategories
const COMMAND_TREE = [
  {
    id: 'filters',
    label: '🔍 Filters',
    icon: '🔍',
    children: [
      {
        id: 'filter-tier',
        label: 'Filter by tier',
        icon: '📊',
        children: [
          { id: 'filter-tier-all', label: 'All tiers', shortcut: 'T', keywords: ['filter', 'tier', 'all'] },
          { id: 'filter-tier-splus', label: 'S+ tier only', keywords: ['filter', 'tier', 's+'] },
          { id: 'filter-tier-s', label: 'S tier only', keywords: ['filter', 'tier', 's'] },
          { id: 'filter-tier-aplus', label: 'A+ tier only', keywords: ['filter', 'tier', 'a+'] },
          { id: 'filter-tier-a', label: 'A tier only', keywords: ['filter', 'tier', 'a'] },
          { id: 'filter-tier-aminus', label: 'A- tier only', keywords: ['filter', 'tier', 'a-'] },
          { id: 'filter-tier-bplus', label: 'B+ tier only', keywords: ['filter', 'tier', 'b+'] },
          { id: 'filter-tier-b', label: 'B tier only', keywords: ['filter', 'tier', 'b'] },
          { id: 'filter-tier-c', label: 'C tier only', keywords: ['filter', 'tier', 'c'] },
        ]
      },
      {
        id: 'filter-provider',
        label: 'Filter by provider',
        icon: '🏢',
        children: [
          { id: 'filter-provider-cycle', label: 'Cycle provider', shortcut: 'D', keywords: ['filter', 'provider', 'origin'] },
        ]
      },
      {
        id: 'filter-other',
        label: 'Other filters',
        icon: '⚙️',
        children: [
          { id: 'filter-configured-toggle', label: 'Toggle configured-only', shortcut: 'E', keywords: ['filter', 'configured', 'keys'] },
        ]
      },
    ]
  },
  {
    id: 'sort',
    label: '📶 Sort',
    icon: '📶',
    children: [
      { id: 'sort-rank', label: 'Sort by rank', shortcut: 'R', keywords: ['sort', 'rank'] },
      { id: 'sort-tier', label: 'Sort by tier', keywords: ['sort', 'tier'] },
      { id: 'sort-provider', label: 'Sort by provider', shortcut: 'O', keywords: ['sort', 'origin', 'provider'] },
      { id: 'sort-model', label: 'Sort by model', shortcut: 'M', keywords: ['sort', 'model', 'name'] },
      { id: 'sort-latest-ping', label: 'Sort by latest ping', shortcut: 'L', keywords: ['sort', 'latest', 'ping'] },
      { id: 'sort-avg-ping', label: 'Sort by avg ping', shortcut: 'A', keywords: ['sort', 'avg', 'average', 'ping'] },
      { id: 'sort-swe', label: 'Sort by SWE score', shortcut: 'S', keywords: ['sort', 'swe', 'score'] },
      { id: 'sort-ctx', label: 'Sort by context', shortcut: 'C', keywords: ['sort', 'context', 'ctx'] },
      { id: 'sort-health', label: 'Sort by health', shortcut: 'H', keywords: ['sort', 'health', 'condition'] },
      { id: 'sort-verdict', label: 'Sort by verdict', shortcut: 'V', keywords: ['sort', 'verdict'] },
      { id: 'sort-stability', label: 'Sort by stability', shortcut: 'B', keywords: ['sort', 'stability'] },
      { id: 'sort-uptime', label: 'Sort by uptime', shortcut: 'U', keywords: ['sort', 'uptime'] },
    ]
  },
  {
    id: 'pages',
    label: '📄 Pages',
    icon: '📄',
    children: [
      { id: 'open-settings', label: 'Settings', shortcut: 'P', keywords: ['settings', 'config', 'api key'] },
      { id: 'open-help', label: 'Help', shortcut: 'K', keywords: ['help', 'shortcuts', 'hotkeys'] },
      { id: 'open-changelog', label: 'Changelog', shortcut: 'N', keywords: ['changelog', 'release'] },
      { id: 'open-feedback', label: 'Feedback', shortcut: 'I', keywords: ['feedback', 'bug', 'request'] },
      { id: 'open-recommend', label: 'Smart recommend', shortcut: 'Q', keywords: ['recommend', 'best model'] },
      { id: 'open-install-endpoints', label: 'Install endpoints', keywords: ['install', 'endpoints', 'providers'] },
    ]
  },
  {
    id: 'actions',
    label: '⚡ Actions',
    icon: '⚡',
    children: [
      { id: 'action-cycle-theme', label: 'Cycle theme', shortcut: 'G', keywords: ['theme', 'dark', 'light', 'auto'] },
      { id: 'action-cycle-tool-mode', label: 'Cycle tool mode', shortcut: 'Z', keywords: ['tool', 'mode', 'launcher'] },
      { id: 'action-cycle-ping-mode', label: 'Cycle ping mode', shortcut: 'W', keywords: ['ping', 'cadence', 'speed', 'slow'] },
      { id: 'action-toggle-favorite', label: 'Toggle favorite', shortcut: 'F', keywords: ['favorite', 'star'] },
      { id: 'action-reset-view', label: 'Reset view', shortcut: 'Shift+R', keywords: ['reset', 'view', 'sort', 'filters'] },
    ]
  },
]

export function buildCommandPaletteTree() {
  return COMMAND_TREE
}

/**
 * 📖 Flatten the command tree into a list, respecting which nodes are expanded.
 * @param {Array} tree - The command tree
 * @param {Set} expandedIds - Set of IDs that are expanded
 * @returns {Array} Flat list with type markers ('category' | 'subcategory' | 'command')
 */
export function flattenCommandTree(tree, expandedIds = new Set()) {
  const result = []
  
  function traverse(nodes, depth = 0) {
    for (const node of nodes) {
      const isExpanded = expandedIds.has(node.id)
      const hasChildren = Array.isArray(node.children) && node.children.length > 0
      
      if (hasChildren) {
        result.push({
          ...node,
          type: depth === 0 ? 'category' : 'subcategory',
          depth,
          hasChildren,
          isExpanded,
        })
        
        if (isExpanded) {
          traverse(node.children, depth + 1)
        }
      } else {
        result.push({
          ...node,
          type: 'command',
          depth,
          hasChildren: false,
          isExpanded: false,
        })
      }
    }
  }
  
  traverse(tree)
  return result
}

const ID_TO_TIER = {
  'filter-tier-all': null,
  'filter-tier-splus': 'S+',
  'filter-tier-s': 'S',
  'filter-tier-aplus': 'A+',
  'filter-tier-a': 'A',
  'filter-tier-aminus': 'A-',
  'filter-tier-bplus': 'B+',
  'filter-tier-b': 'B',
  'filter-tier-c': 'C',
}

/**
 * 📖 Legacy function for backward compatibility - builds flat list from tree.
 * 📖 Expands all categories so every command is searchable by fuzzyMatchCommand.
 */
export function buildCommandPaletteEntries() {
  // 📖 Collect every node id that has children so flattenCommandTree traverses into them.
  const allIds = new Set()
  function collectIds(nodes) {
    for (const n of nodes) {
      allIds.add(n.id)
      if (Array.isArray(n.children)) collectIds(n.children)
    }
  }
  collectIds(COMMAND_TREE)
  const flat = flattenCommandTree(COMMAND_TREE, allIds)
  return flat.map((entry) => ({
    ...entry,
    tierValue: Object.prototype.hasOwnProperty.call(ID_TO_TIER, entry.id) ? ID_TO_TIER[entry.id] : undefined,
  }))
}

/**
 * 📖 Fuzzy matching optimized for short command labels and keyboard aliases.
 * @param {string} query
 * @param {string} text
 * @returns {{ matched: boolean, score: number, positions: number[] }}
 */
export function fuzzyMatchCommand(query, text) {
  const q = (query || '').trim().toLowerCase()
  const t = (text || '').toLowerCase()

  if (!q) return { matched: true, score: 0, positions: [] }
  if (!t) return { matched: false, score: 0, positions: [] }

  let qIdx = 0
  const positions = []
  for (let i = 0; i < t.length && qIdx < q.length; i++) {
    if (q[qIdx] === t[i]) {
      positions.push(i)
      qIdx++
    }
  }

  if (qIdx !== q.length) return { matched: false, score: 0, positions: [] }

  let score = q.length * 10

  // 📖 Bonus when matches are contiguous.
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1] + 1) score += 5
  }

  // 📖 Bonus for word boundaries and prefix matches.
  for (const pos of positions) {
    if (pos === 0) score += 8
    else {
      const prev = t[pos - 1]
      if (prev === ' ' || prev === ':' || prev === '-' || prev === '/') score += 6
    }
  }

  // 📖 Small penalty for very long labels so focused labels float up.
  score -= Math.max(0, t.length - q.length)

  return { matched: true, score, positions }
}

/**
 * 📖 Filter and rank command palette entries by fuzzy score.
 * Now handles hierarchical structure with expandable categories.
 * @param {Array} flatEntries - Flattened command tree entries
 * @param {string} query
 * @returns {Array} Sorted and filtered entries with match scores
 */
export function filterCommandPaletteEntries(flatEntries, query) {
  const normalizedQuery = (query || '').trim()
  
  if (!normalizedQuery) {
    return flatEntries
  }

  const ranked = []
  for (const entry of flatEntries) {
    const labelMatch = fuzzyMatchCommand(normalizedQuery, entry.label)
    let bestScore = labelMatch.score
    let matchPositions = labelMatch.positions
    let matched = labelMatch.matched

    if (!matched && Array.isArray(entry.keywords)) {
      for (const keyword of entry.keywords) {
        const keywordMatch = fuzzyMatchCommand(normalizedQuery, keyword)
        if (!keywordMatch.matched) continue
        matched = true
        const keywordScore = Math.max(1, keywordMatch.score - 7)
        if (keywordScore > bestScore) {
          bestScore = keywordScore
          matchPositions = []
        }
      }
    }

    if (!matched) continue
    ranked.push({ ...entry, score: bestScore, matchPositions })
  }

  // Auto-expand categories that contain matches
  const result = []
  const idsToExpand = new Set()
  
  // First pass: mark all categories containing matched items
  for (const entry of ranked) {
    if (entry.type === 'command' && entry.matchPositions) {
      // Find parent categories
      let current = result.find(r => r.id === entry.id)
      if (current) {
        idsToExpand.add(entry.parentId)
      }
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.label.localeCompare(b.label)
  })

  return ranked
}
