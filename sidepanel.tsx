import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "./style.css"

// ─── types ────────────────────────────────────────────────────────────────────

type Prefs = { staleHours: number; onlyCurrentWindow: boolean }

type Tier = "junk" | "done" | "stale"

type FlaggedTab = {
  tab: chrome.tabs.Tab
  reason: string
  tier: Tier
}

type DoneGroup = {
  reason: string
  tabs: chrome.tabs.Tab[]
}

// ─── constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "tabTidyPrefs"
const DEFAULT_PREFS: Prefs = { staleHours: 24, onlyCurrentWindow: false }

// ─── heuristics ───────────────────────────────────────────────────────────────
//
// Tier "junk"  — definitely useless right now (error, blank, duplicate)
// Tier "done"  — content you've likely consumed (articles, docs, searches, carts)
// Tier "stale" — just old, may still be needed

type HeuristicResult = { reason: string; tier: Tier } | null

function classifyTab(tab: chrome.tabs.Tab): HeuristicResult {
  const url = tab.url ?? ""
  const title = (tab.title ?? "").trim()
  const age = tab.lastAccessed ? Date.now() - tab.lastAccessed : Infinity

  if (tab.active || tab.pinned) return null

  // ── non-http ──────────────────────────────────────────────────────────────
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    if (url === "chrome://newtab/" || url === "about:blank" || url === "about:newtab")
      return { reason: "Empty tab", tier: "junk" }
    return null
  }

  let host = ""
  let pathname = ""
  try { ({ hostname: host, pathname } = new URL(url)) } catch { return null }

  // ── junk: browser/HTTP errors ─────────────────────────────────────────────
  if (url.startsWith("chrome-error://") || /^(ERR_|NET::ERR_)/i.test(title) || title === "No internet")
    return { reason: "Connection error", tier: "junk" }

  if (/^(404|403|410|500|502|503)\b/.test(title) ||
    /\b(page not found|not found|access denied|forbidden)\b/i.test(title))
    return { reason: "Error page", tier: "junk" }

  if (!title || title === "Untitled" || title === url)
    return { reason: "Untitled", tier: "junk" }

  // ── done: idle login page ─────────────────────────────────────────────────
  if (age > 60 * 60_000 &&
    /\b(sign in|log in|login|sign.?up|create account|forgot password|reset password)\b/i.test(title))
    return { reason: "Login page", tier: "done" }

  // ── done: stale cart/checkout ─────────────────────────────────────────────
  if (age > 2 * 60 * 60_000 && /\/(cart|checkout|basket|bag|order\/confirm)/i.test(pathname))
    return { reason: "Abandoned cart", tier: "done" }

  // ── done: stale search results ────────────────────────────────────────────
  if (age > 30 * 60_000 &&
    (/^(www\.)?(google|bing|duckduckgo|yahoo|perplexity|you)\.[^/]+$/.test(host) &&
      /^\/(search|results|hub\/search)/i.test(pathname)))
    return { reason: "Search results", tier: "done" }

  // ── done: article / blog ──────────────────────────────────────────────────
  const ARTICLE_HOSTS = /\b(medium\.com|substack\.com|dev\.to|hashnode\.dev|hackernoon\.com|techcrunch\.com|theverge\.com|wired\.com|arstechnica\.com|thenextweb\.com|venturebeat\.com|infoq\.com|smashingmagazine\.com|css-tricks\.com|perplexity\.ai)\b/i
  const ARTICLE_PATH = /\/(blog|article|articles|post|posts|news|story|stories|hub|insights?|learn|p)\//i

  if (age > 20 * 60_000 && (ARTICLE_HOSTS.test(host) || ARTICLE_PATH.test(pathname)))
    return { reason: "Article", tier: "done" }

  // ── done: docs / reference ────────────────────────────────────────────────
  const DOCS_PATH = /\/(docs?|documentation|reference|api-?ref|guides?|manual|man|faq|changelog|release-?notes?|tutorials?)(\/|$)/i
  const DOCS_HOST = /^(docs?|developer|developers|api|reference|learn)\./i

  if (age > 2 * 60 * 60_000 && (DOCS_PATH.test(pathname) || DOCS_HOST.test(host)))
    return { reason: "Docs page", tier: "done" }

  // ── done: document files ──────────────────────────────────────────────────
  if (age > 60 * 60_000 && /\.(pdf|docx?|xlsx?|pptx?|csv)(\?|$)/i.test(url))
    return { reason: "Document", tier: "done" }

  return null
}

// ─── utils ────────────────────────────────────────────────────────────────────

function normalizeUrl(raw?: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    const path = u.pathname.replace(/\/+$/, "") || "/"
    const qs = new URLSearchParams(
      [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    ).toString()
    return `${u.protocol}//${u.host}${path}${qs ? `?${qs}` : ""}`
  } catch { return null }
}

function ageLabel(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000)
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

function chromeFaviconUrl(raw?: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"))
    faviconUrl.searchParams.set("pageUrl", u.href)
    faviconUrl.searchParams.set("size", "32")
    return faviconUrl.toString()
  } catch {
    return null
  }
}

function siteLabel(raw?: string): string {
  if (!raw) return "unknown"
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return "non-web"
    return u.hostname.replace(/^www\./, "") || "unknown"
  } catch {
    return "unknown"
  }
}

function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...a: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait) }) as T
}

// ─── components ───────────────────────────────────────────────────────────────

function TabRow({
  tab, meta, pill, pillColor, selected, focused, onToggleSelect, onClose, onFocus, onRowFocus
}: {
  tab: chrome.tabs.Tab
  meta?: string
  pill?: string
  pillColor?: string
  selected: boolean
  focused: boolean
  onToggleSelect: () => void
  onClose: () => void
  onFocus: () => void
  onRowFocus: () => void
}) {
  const fallbackFavicon = useMemo(() => chromeFaviconUrl(tab.url), [tab.url])
  const preferredIcon = tab.favIconUrl || fallbackFavicon || ""
  const [iconSrc, setIconSrc] = useState(preferredIcon)

  useEffect(() => {
    setIconSrc(preferredIcon)
  }, [preferredIcon])

  return (
    <div
      className={`flex items-center gap-2 py-[5px] group min-w-0 rounded-md px-1 ${focused ? "bg-slate-100 ring-1 ring-slate-200" : "hover:bg-slate-50/70"}`}
      onMouseDown={onRowFocus}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        onClick={(e) => e.stopPropagation()}
        onFocus={onRowFocus}
        aria-label={`Select tab: ${tab.title || tab.url || "Untitled"}`}
        className="w-4 h-4 shrink-0 accent-slate-700 cursor-pointer"
      />
      {iconSrc
        ? <img
          src={iconSrc}
          className="w-4 h-4 shrink-0 rounded-[3px]"
          alt=""
          onError={() => {
            if (fallbackFavicon && iconSrc !== fallbackFavicon) {
              setIconSrc(fallbackFavicon)
              return
            }
            setIconSrc("")
          }} />
        : <div className="w-3.5 h-3.5 shrink-0 rounded-[3px] bg-slate-200" />
      }
      <button
        onClick={() => {
          onRowFocus()
          void onFocus()
        }}
        title={tab.title || tab.url}
        aria-label={`Focus tab: ${tab.title || tab.url || "Untitled"}`}
        className="flex-1 min-w-0 text-left text-[12px] leading-snug text-slate-700 truncate hover:text-slate-900 cursor-pointer bg-transparent border-0 p-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
        {tab.title || tab.url || "Untitled"}
      </button>
      {pill && (
        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-[2px] rounded-full ${pillColor}`}>
          {pill}
        </span>
      )}
      {meta && !pill && (
        <span className="shrink-0 text-[10px] text-slate-400">{meta}</span>
      )}
      <button
        onClick={() => {
          onRowFocus()
          void onClose()
        }}
        title="Close tab"
        aria-label={`Close tab: ${tab.title || tab.url || "Untitled"}`}
        className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-300 hover:text-red-400 hover:bg-red-50 rounded-md cursor-pointer bg-transparent border-0 p-0 opacity-60 group-hover:opacity-100 transition text-lg leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200">
        ×
      </button>
    </div>
  )
}

const TIER_STYLE = {
  junk:  { dot: "bg-red-400",   label: "text-red-500",   pill: "bg-red-50 text-red-500",    close: "bg-red-50 hover:bg-red-100 text-red-500 border-red-100" },
  done:  { dot: "bg-amber-400", label: "text-amber-600", pill: "bg-amber-50 text-amber-600", close: "bg-amber-50 hover:bg-amber-100 text-amber-600 border-amber-100" },
  stale: { dot: "bg-slate-300", label: "text-slate-500", pill: "bg-slate-100 text-slate-500", close: "bg-slate-100 hover:bg-slate-200 text-slate-500 border-slate-200" },
}

function Section({
  title, subtitle, count, tabs: tabList, renderRow, onCloseAll, tier, defaultOpen = true, emptyText
}: {
  title: string
  subtitle: string
  count: number
  tabs: chrome.tabs.Tab[]
  renderRow: (tab: chrome.tabs.Tab) => React.ReactNode
  onCloseAll: () => void
  tier: Tier
  defaultOpen?: boolean
  emptyText: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const s = TIER_STYLE[tier]

  return (
    <div className="border-b border-slate-100 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer bg-transparent border-0 hover:bg-slate-50/70 transition-colors">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{title}</span>
          {count > 0 && (
            <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-[1px] rounded-full bg-slate-100 text-slate-500">{count}</span>
          )}
          <span className="ml-2 text-[10px] text-slate-400">{subtitle}</span>
        </div>
        <svg className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3">
          {count === 0
            ? <p className="text-[11px] text-slate-400 py-0.5">{emptyText}</p>
            : <>
              {tabList.map(renderRow)}
                <button
                  onClick={onCloseAll}
                  className={`mt-2 w-full py-2 text-[12px] font-medium rounded-md border cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 ${s.close}`}>
                  Close all {count}
                </button>
            </>
          }
        </div>
      )}
    </div>
  )
}

function GroupedSection({
  title,
  subtitle,
  count,
  groups,
  renderRow,
  onCloseAll,
  onCloseGroup,
  tier,
  defaultOpen = true,
  emptyText
}: {
  title: string
  subtitle: string
  count: number
  groups: DoneGroup[]
  renderRow: (tab: chrome.tabs.Tab, groupReason: string) => React.ReactNode
  onCloseAll: () => void
  onCloseGroup: (tabList: chrome.tabs.Tab[], label: string) => void
  tier: Tier
  defaultOpen?: boolean
  emptyText: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const s = TIER_STYLE[tier]

  return (
    <div className="border-b border-slate-100 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer bg-transparent border-0 hover:bg-slate-50/70 transition-colors">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{title}</span>
          {count > 0 && (
            <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-[1px] rounded-full bg-slate-100 text-slate-500">{count}</span>
          )}
          <span className="ml-2 text-[10px] text-slate-400">{subtitle}</span>
        </div>
        <svg className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3">
          {count === 0 ? (
            <p className="text-[11px] text-slate-400 py-0.5">{emptyText}</p>
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.reason} className="pt-2 first:pt-0">
                  <div className="flex items-center justify-between pb-1">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                      {group.reason}
                    </span>
                    <button
                      onClick={() => onCloseGroup(group.tabs, `${group.reason.toLowerCase()} tabs`)}
                      className="text-[11px] text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-md cursor-pointer bg-transparent border border-amber-100 px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200">
                      Close {group.tabs.length}
                    </button>
                  </div>
                  {group.tabs.map((tab) => renderRow(tab, group.reason))}
                </div>
              ))}

              <button
                onClick={onCloseAll}
                className={`mt-2 w-full py-2 text-[12px] font-medium rounded-md border cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 ${s.close}`}>
                Close all {count}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── main ─────────────────────────────────────────────────────────────────────

function SidePanel() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([])
  const [flash, setFlash] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [cursorTabId, setCursorTabId] = useState<number | null>(null)
  const undoStackRef = useRef<number[]>([])

  const savePrefs = async (next: Prefs) => {
    setPrefs(next)
    await chrome.storage.sync.set({ [STORAGE_KEY]: next })
  }

  const refresh = useCallback(async () => {
    const q = prefs.onlyCurrentWindow ? { currentWindow: true } : {}
    setTabs(await chrome.tabs.query(q))
  }, [prefs.onlyCurrentWindow])

  useEffect(() => {
    chrome.storage.sync.get(STORAGE_KEY).then((res) => {
      const s = res[STORAGE_KEY] as Prefs | undefined
      if (s) setPrefs({ ...DEFAULT_PREFS, ...s })
    })
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const soon = debounce(() => void refresh(), 300)
    chrome.tabs.onCreated.addListener(soon)
    chrome.tabs.onRemoved.addListener(soon)
    chrome.tabs.onUpdated.addListener(soon)
    chrome.tabs.onActivated.addListener(soon)
    return () => {
      chrome.tabs.onCreated.removeListener(soon)
      chrome.tabs.onRemoved.removeListener(soon)
      chrome.tabs.onUpdated.removeListener(soon)
      chrome.tabs.onActivated.removeListener(soon)
    }
  }, [refresh])

  // ── derived ───────────────────────────────────────────────────────────────

  // duplicates = extra copies of same URL (keep first-seen)
  const duplicates = useMemo(() => {
    const seen = new Set<string>()
    const dupes: chrome.tabs.Tab[] = []
    for (const tab of tabs) {
      const key = normalizeUrl(tab.url)
      if (!key) continue
      if (seen.has(key)) dupes.push(tab)
      else seen.add(key)
    }
    return dupes
  }, [tabs])

  // heuristic-flagged (exclude duplicates to avoid double listing)
  const dupeIds = useMemo(() => new Set(duplicates.map((t) => t.id)), [duplicates])

  const flagged = useMemo((): FlaggedTab[] => {
    return tabs
      .filter((t) => !dupeIds.has(t.id))
      .flatMap((tab) => {
        const result = classifyTab(tab)
        if (!result) return []
        return [{ tab, ...result }]
      })
  }, [tabs, dupeIds])

  const junkTabs  = useMemo(() => flagged.filter((f) => f.tier === "junk"),  [flagged])
  const doneTabs  = useMemo(() => flagged.filter((f) => f.tier === "done"),  [flagged])
  const doneGroups = useMemo((): DoneGroup[] => {
    const groups = new Map<string, chrome.tabs.Tab[]>()

    for (const item of doneTabs) {
      const list = groups.get(item.reason) ?? []
      list.push(item.tab)
      groups.set(item.reason, list)
    }

    const reasonOrder = [
      "Abandoned cart",
      "Search results",
      "Article",
      "Docs page",
      "Document",
      "Login page"
    ]

    const reasonRank = (reason: string) => {
      const idx = reasonOrder.indexOf(reason)
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
    }

    return [...groups.entries()]
      .map(([reason, tabList]) => ({
        reason,
        tabs: [...tabList].sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0))
      }))
      .sort((a, b) => {
        const rankDiff = reasonRank(a.reason) - reasonRank(b.reason)
        if (rankDiff !== 0) return rankDiff
        return b.tabs.length - a.tabs.length
      })
  }, [doneTabs])

  // stale = not accessed in threshold, not already flagged
  const flaggedIds = useMemo(() => new Set(flagged.map((f) => f.tab.id)), [flagged])
  const staleTabs = useMemo(() => {
    const threshold = Date.now() - prefs.staleHours * 3_600_000
    return tabs.filter(
      (t) => !dupeIds.has(t.id) && !flaggedIds.has(t.id) &&
        !t.active && !t.pinned && normalizeUrl(t.url) &&
        typeof t.lastAccessed === "number" && t.lastAccessed < threshold
    )
  }, [tabs, prefs.staleHours, dupeIds, flaggedIds])

  const classifiedTabIds = useMemo(() => {
    const ids = new Set<number>()
    for (const tab of [
      ...duplicates,
      ...junkTabs.map((f) => f.tab),
      ...doneTabs.map((f) => f.tab),
      ...staleTabs
    ]) {
      if (tab.id != null) ids.add(tab.id)
    }
    return ids
  }, [duplicates, junkTabs, doneTabs, staleTabs])

  const otherTabs = useMemo(() => {
    return tabs.filter((tab) => tab.id == null || !classifiedTabIds.has(tab.id))
  }, [tabs, classifiedTabIds])

  const otherTabsOrdered = useMemo(() => {
    return [...otherTabs].sort((a, b) => {
      const siteA = siteLabel(a.url)
      const siteB = siteLabel(b.url)
      const siteDiff = siteA.localeCompare(siteB)
      if (siteDiff !== 0) return siteDiff
      return (a.lastAccessed || 0) - (b.lastAccessed || 0)
    })
  }, [otherTabs])

  const navigableTabs = useMemo(() => {
    return [
      ...duplicates,
      ...junkTabs.map((f) => f.tab),
      ...doneTabs.map((f) => f.tab),
      ...staleTabs,
      ...otherTabs
    ]
  }, [duplicates, junkTabs, doneTabs, staleTabs, otherTabs])

  const wasteTabIds = useMemo(
    () => navigableTabs.map((t) => t.id).filter((id): id is number => id != null),
    [navigableTabs]
  )

  const selectedTabs = useMemo(() => {
    const byId = new Map<number, chrome.tabs.Tab>()
    for (const tab of tabs) {
      if (tab.id != null) byId.set(tab.id, tab)
    }
    return [...selectedIds]
      .map((id) => byId.get(id))
      .filter((t): t is chrome.tabs.Tab => t != null)
  }, [tabs, selectedIds])

  const selectedCount = selectedTabs.length
  const totalWaste = duplicates.length + junkTabs.length + doneTabs.length + staleTabs.length

  useEffect(() => {
    const existingIds = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null))
    setSelectedIds((prev) => {
      let changed = false
      const next = new Set<number>()
      for (const id of prev) {
        if (existingIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tabs])

  useEffect(() => {
    if (!wasteTabIds.length) {
      setCursorTabId(null)
      return
    }
    setCursorTabId((prev) => (prev != null && wasteTabIds.includes(prev) ? prev : wasteTabIds[0]))
  }, [wasteTabIds])

  // ── actions ───────────────────────────────────────────────────────────────

  const pushUndo = (count: number) => {
    if (count > 0) undoStackRef.current.push(count)
  }

  const setFlashMessage = (message: string) => {
    setFlash(message)
    setTimeout(() => setFlash(""), 3000)
  }

  const confirmClose = (count: number, label: string) => {
    return window.confirm(`Close ${count} ${label}?\n\nYou can undo with Ctrl/Cmd+Z.`)
  }

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const closeTab = async (id: number) => {
    await chrome.tabs.remove(id)
    pushUndo(1)
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await refresh()
    setFlashMessage("Closed 1 tab")
  }

  const focusTab = async (tab: chrome.tabs.Tab) => {
    if (tab.id == null) return
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tab.id, { active: true })
  }

  const closeAll = async (tabList: chrome.tabs.Tab[], label: string, requireConfirm = false) => {
    const ids = tabList.map((t) => t.id).filter((id): id is number => id != null)
    if (!ids.length) return
    if (requireConfirm && !confirmClose(ids.length, label)) return
    await chrome.tabs.remove(ids)
    pushUndo(ids.length)
    setSelectedIds((prev) => {
      if (!prev.size) return prev
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
    await refresh()
    setFlashMessage(`Closed ${ids.length} ${label}`)
  }

  const closeSelected = async () => {
    if (!selectedTabs.length) {
      setFlashMessage("No tabs selected")
      return
    }
    await closeAll(selectedTabs, "selected tabs", true)
  }

  const closeFocusedWithConfirm = async () => {
    if (cursorTabId == null) return
    if (!confirmClose(1, "tab")) return
    await closeTab(cursorTabId)
  }

  const undoClose = async () => {
    const count = undoStackRef.current.pop()
    if (!count) {
      setFlashMessage("Nothing to undo")
      return
    }

    let restored = 0
    for (let i = 0; i < count; i += 1) {
      try {
        const result = await chrome.sessions.restore()
        if (!result) break
        restored += 1
      } catch {
        break
      }
    }

    await refresh()
    if (!restored) {
      setFlashMessage("Unable to restore closed tabs")
      return
    }
    setFlashMessage(`Restored ${restored} tab${restored === 1 ? "" : "s"}`)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName.toLowerCase()
        if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) {
          return
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault()
        void undoClose()
        return
      }

      if (!wasteTabIds.length) return

      const currentIndex = cursorTabId != null ? wasteTabIds.indexOf(cursorTabId) : -1

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const dir = event.key === "ArrowDown" ? 1 : -1
        const base = currentIndex >= 0 ? currentIndex : 0
        const nextIndex = (base + dir + wasteTabIds.length) % wasteTabIds.length
        setCursorTabId(wasteTabIds[nextIndex])
        return
      }

      if (event.key === " ") {
        if (cursorTabId == null) return
        event.preventDefault()
        toggleSelected(cursorTabId)
        return
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        if (selectedCount > 0) {
          void closeSelected()
          return
        }
        if (cursorTabId != null) {
          void closeFocusedWithConfirm()
        }
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [wasteTabIds, cursorTabId, selectedCount, closeSelected, closeFocusedWithConfirm])

  const rowInteractionProps = (tab: chrome.tabs.Tab) => {
    const id = tab.id ?? -1
    const hasId = tab.id != null
    return {
      selected: hasId && selectedIds.has(id),
      focused: hasId && cursorTabId === id,
      onToggleSelect: () => {
        if (!hasId) return
        toggleSelected(id)
      },
      onRowFocus: () => {
        if (!hasId) return
        setCursorTabId(id)
      }
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-white text-slate-800 overflow-hidden">

      {/* header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-100 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[13px]">Tab Tidy</span>
          <span className="text-[11px] text-slate-400">{tabs.length} open</span>
        </div>
        <div className="flex items-center gap-2.5">
          {totalWaste > 0 && (
            <span className="text-[11px] font-medium text-red-400">{totalWaste} closeable</span>
          )}
          {selectedCount > 0 && (
            <button
              onClick={() => void closeSelected()}
              title="Delete selected tabs (Delete key)"
              className="px-2.5 py-1.5 text-[11px] font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-100 rounded-md cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200">
              Delete {selectedCount}
            </button>
          )}
          <button onClick={() => void refresh()} title="Refresh"
            className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md cursor-pointer bg-transparent border-0 p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* settings */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-100 bg-slate-50/60 shrink-0">
        <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
          <input type="checkbox" checked={prefs.onlyCurrentWindow}
            onChange={(e) => void savePrefs({ ...prefs, onlyCurrentWindow: e.target.checked })} />
          This window
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-500 ml-auto">
          Stale after
          <select value={prefs.staleHours}
            onChange={(e) => void savePrefs({ ...prefs, staleHours: Number(e.target.value) })}
            className="border border-slate-200 rounded px-1 py-0.5 text-[11px] bg-white text-slate-700">
            <option value={6}>6h</option>
            <option value={12}>12h</option>
            <option value={24}>1d</option>
            <option value={48}>2d</option>
            <option value={168}>7d</option>
          </select>
        </label>
      </div>

      {/* legend */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-100 shrink-0">
        {(["junk", "done", "stale"] as Tier[]).map((tier) => (
          <div key={tier} className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${TIER_STYLE[tier].dot}`} />
            <span className={`text-[10px] font-medium ${TIER_STYLE[tier].label}`}>
              {tier === "junk" ? "Junk" : tier === "done" ? "Likely done" : "Stale"}
            </span>
          </div>
        ))}
      </div>

      {/* lists */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {totalWaste === 0 && otherTabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-2">
            <div className="text-xl">✓</div>
            <p className="text-[12px] font-medium text-slate-600">Tabs look clean</p>
            <p className="text-[11px] text-slate-400">No duplicates, junk, or stale tabs found.</p>
          </div>
        ) : (
          <>
            {/* duplicates always shown first */}
            {duplicates.length > 0 && (
              <Section
                title="Duplicates" subtitle="exact same URL"
                count={duplicates.length} tabs={duplicates} tier="junk"
                onCloseAll={() => void closeAll(duplicates, "duplicates", true)}
                emptyText="No duplicates."
                renderRow={(tab) => (
                  <TabRow key={tab.id} tab={tab}
                    {...rowInteractionProps(tab)}
                    onClose={() => void closeTab(tab.id!)}
                    onFocus={() => void focusTab(tab)} />
                )} />
            )}

            <Section
              title="Junk" subtitle="errors, blanks"
              count={junkTabs.length} tabs={junkTabs.map((f) => f.tab)} tier="junk"
              onCloseAll={() => void closeAll(junkTabs.map((f) => f.tab), "junk tabs", true)}
              emptyText="No junk tabs."
              renderRow={(tab) => {
                const f = junkTabs.find((x) => x.tab.id === tab.id)!
                return (
                  <TabRow key={tab.id} tab={tab}
                    {...rowInteractionProps(tab)}
                    pill={f.reason} pillColor={TIER_STYLE.junk.pill}
                    onClose={() => void closeTab(tab.id!)}
                    onFocus={() => void focusTab(tab)} />
                )
              }} />

            <GroupedSection
              title="Likely done" subtitle="articles, docs, searches"
              count={doneTabs.length} groups={doneGroups} tier="done"
              onCloseAll={() => void closeAll(doneTabs.map((f) => f.tab), "done tabs", true)}
              onCloseGroup={(tabList, label) => void closeAll(tabList, label, true)}
              emptyText="Nothing flagged."
              renderRow={(tab, groupReason) => (
                <TabRow key={tab.id} tab={tab}
                  {...rowInteractionProps(tab)}
                  pill={groupReason} pillColor={TIER_STYLE.done.pill}
                  meta={tab.lastAccessed ? ageLabel(tab.lastAccessed) : undefined}
                  onClose={() => void closeTab(tab.id!)}
                  onFocus={() => void focusTab(tab)} />
              )} />

            <Section
              title="Stale" subtitle={`idle >${prefs.staleHours}h`}
              count={staleTabs.length} tabs={staleTabs} tier="stale"
              onCloseAll={() => void closeAll(staleTabs, "stale tabs", true)}
              emptyText={`No tabs idle for ${prefs.staleHours}h.`}
              defaultOpen={false}
              renderRow={(tab) => (
                <TabRow key={tab.id} tab={tab}
                  {...rowInteractionProps(tab)}
                  meta={tab.lastAccessed ? ageLabel(tab.lastAccessed) : undefined}
                  onClose={() => void closeTab(tab.id!)}
                  onFocus={() => void focusTab(tab)} />
              )} />

            <Section
              title="Other" subtitle="not auto-tagged"
              count={otherTabsOrdered.length} tabs={otherTabsOrdered} tier="stale"
              onCloseAll={() => void closeAll(otherTabsOrdered, "other tabs", true)}
              emptyText="No other tabs."
              defaultOpen={false}
              renderRow={(tab) => (
                <TabRow key={tab.id} tab={tab}
                  {...rowInteractionProps(tab)}
                  pill={siteLabel(tab.url)}
                  pillColor={TIER_STYLE.stale.pill}
                  meta={tab.lastAccessed ? ageLabel(tab.lastAccessed) : undefined}
                  onClose={() => void closeTab(tab.id!)}
                  onFocus={() => void focusTab(tab)} />
              )} />
          </>
        )}
      </div>

      {flash && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100 bg-slate-50">
          {flash}
        </div>
      )}
    </div>
  )
}

export default SidePanel
