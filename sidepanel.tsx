import { useCallback, useEffect, useMemo, useState } from "react"
import "./style.css"

// ─── types ────────────────────────────────────────────────────────────────────

type Prefs = { staleHours: number; onlyCurrentWindow: boolean }

type Tier = "junk" | "done" | "stale"

type FlaggedTab = {
  tab: chrome.tabs.Tab
  reason: string
  tier: Tier
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

function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...a: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait) }) as T
}

// ─── components ───────────────────────────────────────────────────────────────

function TabRow({
  tab, meta, pill, pillColor, onClose, onFocus
}: {
  tab: chrome.tabs.Tab
  meta?: string
  pill?: string
  pillColor?: string
  onClose: () => void
  onFocus: () => void
}) {
  return (
    <div className="flex items-center gap-2 py-[5px] group min-w-0">
      {tab.favIconUrl
        ? <img src={tab.favIconUrl} className="w-3.5 h-3.5 shrink-0 rounded-[3px]" alt="" />
        : <div className="w-3.5 h-3.5 shrink-0 rounded-[3px] bg-slate-200" />
      }
      <button
        onClick={onFocus}
        title={tab.title || tab.url}
        className="flex-1 min-w-0 text-left text-[12px] leading-snug text-slate-700 truncate hover:text-slate-900 cursor-pointer bg-transparent border-0 p-0">
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
        onClick={onClose}
        className="shrink-0 w-4 h-4 flex items-center justify-center text-slate-300 hover:text-red-400 cursor-pointer bg-transparent border-0 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-base leading-none">
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
                className={`mt-2 w-full py-[5px] text-[11px] font-medium rounded-md border cursor-pointer transition-colors ${s.close}`}>
                Close all {count}
              </button>
            </>
          }
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

  const totalWaste = duplicates.length + junkTabs.length + doneTabs.length + staleTabs.length

  // ── actions ───────────────────────────────────────────────────────────────

  const closeTab = async (id: number) => { await chrome.tabs.remove(id); await refresh() }

  const focusTab = async (tab: chrome.tabs.Tab) => {
    if (tab.id == null) return
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tab.id, { active: true })
  }

  const closeAll = async (tabList: chrome.tabs.Tab[], label: string) => {
    const ids = tabList.map((t) => t.id).filter((id): id is number => id != null)
    if (!ids.length) return
    await chrome.tabs.remove(ids)
    await refresh()
    setFlash(`Closed ${ids.length} ${label}`)
    setTimeout(() => setFlash(""), 3000)
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
          <button onClick={() => void refresh()} title="Refresh"
            className="text-slate-400 hover:text-slate-600 cursor-pointer bg-transparent border-0 p-0 transition-colors">
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
        {totalWaste === 0 ? (
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
                onCloseAll={() => void closeAll(duplicates, "duplicates")}
                emptyText="No duplicates."
                renderRow={(tab) => (
                  <TabRow key={tab.id} tab={tab}
                    onClose={() => void closeTab(tab.id!)}
                    onFocus={() => void focusTab(tab)} />
                )} />
            )}

            <Section
              title="Junk" subtitle="errors, blanks"
              count={junkTabs.length} tabs={junkTabs.map((f) => f.tab)} tier="junk"
              onCloseAll={() => void closeAll(junkTabs.map((f) => f.tab), "junk tabs")}
              emptyText="No junk tabs."
              renderRow={(tab) => {
                const f = junkTabs.find((x) => x.tab.id === tab.id)!
                return (
                  <TabRow key={tab.id} tab={tab}
                    pill={f.reason} pillColor={TIER_STYLE.junk.pill}
                    onClose={() => void closeTab(tab.id!)}
                    onFocus={() => void focusTab(tab)} />
                )
              }} />

            <Section
              title="Likely done" subtitle="articles, docs, searches"
              count={doneTabs.length} tabs={doneTabs.map((f) => f.tab)} tier="done"
              onCloseAll={() => void closeAll(doneTabs.map((f) => f.tab), "done tabs")}
              emptyText="Nothing flagged."
              renderRow={(tab) => {
                const f = doneTabs.find((x) => x.tab.id === tab.id)!
                return (
                  <TabRow key={tab.id} tab={tab}
                    pill={f.reason} pillColor={TIER_STYLE.done.pill}
                    meta={tab.lastAccessed ? ageLabel(tab.lastAccessed) : undefined}
                    onClose={() => void closeTab(tab.id!)}
                    onFocus={() => void focusTab(tab)} />
                )
              }} />

            <Section
              title="Stale" subtitle={`idle >${prefs.staleHours}h`}
              count={staleTabs.length} tabs={staleTabs} tier="stale"
              onCloseAll={() => void closeAll(staleTabs, "stale tabs")}
              emptyText={`No tabs idle for ${prefs.staleHours}h.`}
              defaultOpen={false}
              renderRow={(tab) => (
                <TabRow key={tab.id} tab={tab}
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
