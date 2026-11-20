import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Agent, Call, Connector, FileEntry, Inventory, Meta, Outcome, Plan, SessionStats, Site, Skill, SkillSpend, Spend, Step, View, Weight, Weights } from '../types'
import { amount, credsByKind, DOLLARS_PER_CRED, modelName, readCreds, setCacheMinutes, weigh, writeCreds } from './creds'
import type { Usage } from './creds'
import { LOGOS } from './logos'
import { cliCalls, connectorOf, ownNameOf, plainTool, setOwnNames, slug } from './names'

const PANE = 'chat-monitor'
const TITLE = 'In this chat'
const MAX_CALLS = 50
const CALLS_SHOWN = 12
const FILES_SHOWN = 8
const ROWS_SHOWN = 30
const MAX_SEARCHES = 50
const MAX_AGENTS = 100
/** Rows per list in the copied summary. */
const LIST_SHOWN = 50
// A safety net only: each reload already lets go of the ids the chat no longer shows.
const MAX_COUNTED = 20_000
/** A subagent row's timer stops moving after this long, so a row left running by a lost event ticks no more. */
const TICK_AGENTS_MS = 6 * 60 * 60_000
/** A main-chat request this big or bigger can count as a cold send. */
const COLD_MIN_TOKENS = 10_000

const ACCENT = 'claude'
const GOOD = 'success'
const WARN = 'warning'
const BAD = 'error'
// One steady color per connector, picked from its name.
const HUES = ['#d97757', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1']

// The to-do list comes from whichever list tool the chat uses.
const DESKTOP_PLAN = 'mcp__ccd_turn__update_plan'
const DESKTOP_WRAP = 'mcp__ccd_turn__wrap_up'
const PLAN_TOOLS = new Set([DESKTOP_PLAN, DESKTOP_WRAP, 'TodoWrite', 'TaskCreate', 'TaskUpdate'])
const AGENT_TOOL = 'Agent'

const EMPTY: Inventory = { connectors: [], files: [], skills: [], sites: [], searches: [], agents: [], counted: [] }
const NO_PLAN: Plan = { title: '', steps: [], updatedAt: 0 }
const FIRST_VIEW: View = { open: '', folded: [], allFiles: false, closed: false }
const NO_META: Meta = { transcript: '' }
const NO_WEIGHTS: Weights = { model: '', connectors: [], skills: [], files: [], onDemand: [], at: 0 }
const NO_SPEND: Spend = { carried: {}, requests: 0, byAgent: {}, agentUsd: {} }
const NO_SESSION: SessionStats = {
  at: 0,
  source: '',
  prompts: 0,
  requests: 0,
  tools: 0,
  workingMs: 0,
  tokens: { read: 0, write: 0, fresh: 0 },
  creds: { read: 0, write: 0, fresh: 0, output: 0 },
  cold: { count: 0, creds: 0 },
  priciest: { creds: 0, text: '' },
  promptCreds: 0,
  skills: {},
}
const NO_SKILL_SPEND: SkillSpend = { tokens: 0, loads: 0, requests: 0, creds: 0, turns: 0, turnCreds: 0 }
// inv-2 keys a claude.ai connector by its server id; a value stored as inv-1 reads as empty, and the
// chat is counted again from its messages. What later versions added is filled in as a list is read.
const invAtom = atom({ plugin: 'chat-monitor', key: 'inv' } as const, EMPTY, { shape: 'inv-2' })
const planAtom = atom({ plugin: 'chat-monitor', key: 'plan' } as const, NO_PLAN, { shape: 'plan-1' })
const viewAtom = atom({ plugin: 'chat-monitor', key: 'view' } as const, FIRST_VIEW, { shape: 'view-1' })
const metaAtom = atom({ plugin: 'chat-monitor', key: 'meta' } as const, NO_META, { shape: 'meta-1' })
// session-4 drops 1.9.0's scale to Claude Code's cost: a value stored by an earlier version reads as empty and is worked out again.
const sessionAtom = atom({ plugin: 'chat-monitor', key: 'session' } as const, NO_SESSION, { shape: 'session-4' })
const weightsAtom = atom({ plugin: 'chat-monitor', key: 'weights' } as const, NO_WEIGHTS, { shape: 'weights-1' })
const spendAtom = atom({ plugin: 'chat-monitor', key: 'spend' } as const, NO_SPEND, { shape: 'spend-1' })
const nowAtom = atom({ plugin: 'chat-monitor', key: 'now' } as const, 0, { shape: 'now-1' })

// Module variables start over on a reload; the lists themselves live in $.state.
let home = ''
/** The home folder's 8.3 short spellings (C:/Users/SHREYA~1), as TEMP gives them. */
let homeAliases: string[] = []
let configDir = ''
let seq = 0
let autoOpen = true
/** A call that runs at least this long is marked slow. */
let slowMs = 30_000
let skillNames = new Set<string>()
let ready: Promise<void> = Promise.resolve()
/** Ticks once a second while a subagent runs, so its timer moves; undefined while none runs. */
let ticker: { cancel: () => void } | undefined
/** The recording jobs, run one after another off the tool call's own path. */
let chain: Promise<void> = Promise.resolve()

const slashes = (path: string) => path.replace(/\\/g, '/')
/** One spelling per file: forward slashes, and the home folder's long name in place of its short one. */
function canon(path: string): string {
  const flat = slashes(path)
  const lower = flat.toLowerCase()
  for (const alias of homeAliases) {
    const low = alias.toLowerCase()
    if (lower === low || lower.startsWith(`${low}/`)) return `${home}${flat.slice(alias.length)}`
  }
  return flat
}
/** What every spelling of one file shares: a Windows path ignores case. */
const fileKey = (path: string) => (/^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path)
/** A path under the home folder as ~/...; any other as it is. */
const tilde = (path: string) => {
  const low = path.toLowerCase()
  const base = home.toLowerCase()
  return home && (low === base || low.startsWith(`${base}/`)) ? `~${path.slice(home.length)}` : path
}
const clip = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const leaf = (path: string) => {
  const flat = slashes(path).replace(/\/+$/, '')
  return flat.includes('/') ? flat.slice(flat.lastIndexOf('/') + 1) : flat
}
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const two = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  if (!ms) return ''
  const date = new Date(ms)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}
/** How long a call took: 850ms, 4.2s, 42s, 3m 05s, 1h 12m. */
function took(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ${two(Math.floor((ms % 60_000) / 1000))}s`
  return `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
}
/** A running call's timer: 0:42, 3:05, 1:02:10. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}:${two(s % 60)}` : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}
const firstLine = (text: string) =>
  clip(
    text
      .replace(/<\/?[a-z_]+>/gi, ' ')
      .split('\n')
      .map(part => part.trim())
      .find(Boolean) ?? '',
    100,
  )
/** "https://www.example.com/docs?a=1" → "example.com". */
const hostOf = (url: string) => (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)?.[1] ?? '').toLowerCase().replace(/^www\./, '') || clip(url, 40)
/** A fetched URL without its scheme and host, which its site row already shows. */
const pathOf = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') || '/'
const newestFirst = <T extends { seq: number }>(rows: readonly T[]) => [...rows].sort((a, b) => b.seq - a.seq)
const hueOf = (key: string) => {
  let sum = 0
  for (let i = 0; i < key.length; i += 1) sum = (sum * 31 + key.charCodeAt(i)) % 9973
  return HUES[sum % HUES.length]!
}
const total = (rows: readonly { tokens: number }[]) => rows.reduce((sum, row) => sum + row.tokens, 0)

// ---- Pictures ----

const picture = (body: string, size = 16) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`
// ---- The look ----
//
// Quiet cards on the pane's own background: hairlines and insets in a translucent grey that reads on
// light and dark alike, one warm accent (Claude's), small lowercase monospace labels over each
// section, and figures in a heavier weight with even digits. Rows lift on hover; tags are tinted
// chips. The terminal keeps its theme's colours and draws the same layout in text.

/** A card's hairline, an inset's fill, a chip's fill: translucent grey, light and dark alike. */
const LINE = '#8080803d'
const FILL = '#80808017'
const CHIP = '#80808026'
/** The pictures' colours: the accent, the tones, and two for the split of creds. */
const HUE = { accent: '#d97757', good: '#16a34a', warn: '#d97706', bad: '#dc2626', blue: '#3b82f6', violet: '#8b5cf6', grey: '#8a8a8a' }
/** A tag's fill in its own colour, faint. */
const tint = (hex: string) => `${hex}29`
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** A rounded tile, faintly in `hex`, holding a glyph in it: a site's initial, a skill's slash. */
function glyphTile(glyph: string, hex: string): string {
  const safe = glyph.replace(/[<>&"]/g, '?')
  return picture(
    `<rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="${hex}" fill-opacity="0.1" stroke="${hex}" stroke-opacity="0.3"/>` +
      `<text x="16" y="21.5" text-anchor="middle" font-family="${MONO}" font-size="16" font-weight="600" fill="${hex}">${safe}</text>`,
    32,
  )
}
const tileFrame = (hex: string) => `<rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="${hex}" fill-opacity="0.1" stroke="${hex}" stroke-opacity="0.3"/>`
/** The Searches row's tile: a magnifier. */
const SEARCH_TILE = picture(
  `${tileFrame(HUE.blue)}<circle cx="14.5" cy="14.5" r="6" fill="none" stroke="${HUE.blue}" stroke-width="2"/><path d="M19 19l5 5" stroke="${HUE.blue}" stroke-width="2.2" stroke-linecap="round"/>`,
  32,
)
/** A subagent's tile by how it stands: a spinner while it runs, then a check, a cross or a bar. */
const AGENT_TILES = {
  running: picture(
    `${tileFrame(HUE.accent)}<circle cx="16" cy="16" r="7" fill="none" stroke="${HUE.accent}" stroke-opacity="0.25" stroke-width="2.4"/>` +
      `<path d="M16 9a7 7 0 0 1 7 7" fill="none" stroke="${HUE.accent}" stroke-width="2.4" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="1s" repeatCount="indefinite"/></path>`,
    32,
  ),
  done: picture(`${tileFrame(HUE.good)}<path d="M10.5 16.5l3.6 3.6 7.4-8" fill="none" stroke="${HUE.good}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`, 32),
  failed: picture(`${tileFrame(HUE.bad)}<path d="M11.5 11.5l9 9M20.5 11.5l-9 9" stroke="${HUE.bad}" stroke-width="2.4" stroke-linecap="round"/>`, 32),
  blocked: picture(`${tileFrame(HUE.warn)}<circle cx="16" cy="16" r="6.5" fill="none" stroke="${HUE.warn}" stroke-width="2.2"/><path d="M11.5 20.5l9-9" stroke="${HUE.warn}" stroke-width="2.2" stroke-linecap="round"/>`, 32),
}

/** A bar of parts side by side, each its own colour, stretched to the room it is given. */
function splitBar(parts: readonly { share: number; hex: string }[], height = 8): string {
  const W = 400
  const GAP = 3
  const shown = parts.filter(part => part.share > 0)
  const sum = shown.reduce((all, part) => all + part.share, 0) || 1
  const room = W - GAP * Math.max(0, shown.length - 1)
  let x = 0
  const rects = shown.map(part => {
    const w = (part.share / sum) * room
    const rect = `<rect x="${x.toFixed(2)}" width="${Math.max(1, w).toFixed(2)}" height="${height}" rx="${height / 2}" fill="${part.hex}"/>`
    x += w + GAP
    return rect
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" preserveAspectRatio="none">${rects.join('')}</svg>`
}
/** A thin track with its share filled from the left, stretched to the room it is given. */
function thinBar(share: number, hex: string): string {
  const W = 400
  const filled = Math.max(0, Math.min(1, share)) * W
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 4" width="${W}" height="4" preserveAspectRatio="none">` +
    `<rect width="${W}" height="4" rx="2" fill="#808080" fill-opacity="0.18"/>` +
    (filled ? `<rect width="${Math.max(4, filled).toFixed(1)}" height="4" rx="2" fill="${hex}"/>` : '') +
    '</svg>'
  )
}

const MARKS: Record<Step['status'], string> = {
  completed: picture('<circle cx="8" cy="8" r="7" fill="#16a34a"/><path d="M4.8 8.3l2.2 2.2 4.2-4.7" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  // The step under way breathes: its core shrinks and grows, on its own, as long as it runs.
  in_progress: picture(
    '<circle cx="8" cy="8" r="6.3" fill="none" stroke="#d97757" stroke-width="1.4"/>' +
      '<circle cx="8" cy="8" r="2.6" fill="#d97757"><animate attributeName="r" values="2.6;1.5;2.6" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" dur="1.6s" repeatCount="indefinite"/></circle>',
  ),
  pending: picture('<circle cx="8" cy="8" r="6.3" fill="none" stroke="#9a9a9a" stroke-width="1.2"/>'),
}
/** The line that joins one step's mark to the next one's. */
const STEP_LINE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8" width="16" height="8"><path d="M8 0v8" stroke="#8a8a8a" stroke-opacity="0.5" stroke-width="1.2"/></svg>'
// Logo keys that differ from the connector's own.
const LOGO_KEY: Record<string, string> = { googleworkspace: 'google', metaads: 'meta' }

/** The connector's logo, or a white tile with its initial in its own color. */
function tileOf(key: string, name: string): string {
  const logo = LOGOS[LOGO_KEY[key] ?? key]
  if (logo) return logo.svg
  const initial = (name[0] ?? '?').toUpperCase().replace(/[<>&]/g, '?')
  return picture(
    `<rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#ffffff" stroke="#d9d9d9"/><text x="16" y="21.5" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="16" font-weight="700" fill="${hueOf(key)}">${initial}</text>`,
    32,
  )
}

/** The name a connector row shows: the person's own name for it first. */
const labelOf = (row: Connector) => (row.server && ownNameOf(row.server)) || row.name

// ---- A stored list, whatever version stored it ----

/** A list as stored, with what an earlier version did not keep filled in. */
function fill(list: Inventory): Inventory {
  return {
    ...EMPTY,
    ...list,
    connectors: (list.connectors ?? []).map(row => ({ ...row, failed: row.failed ?? 0, blocked: row.blocked ?? 0 })),
    files: (list.files ?? []).map(row => ({ ...row, ok: row.ok ?? true, failed: row.failed ?? 0, blocked: row.blocked ?? 0 })),
    sites: list.sites ?? [],
    searches: list.searches ?? [],
    agents: list.agents ?? [],
  }
}
const readInv = async ($: EngineInterface) => fill(await read($, invAtom))
const updateInv = ($: EngineInterface, change: (list: Inventory) => Inventory) => update($, invAtom, list => change(fill(list)))

// ---- What one tool call adds ----

// Argument names worth showing, best first.
const DETAIL_KEYS = ['query', 'q', 'search', 'keyword', 'url', 'file_path', 'path', 'name', 'title', 'subject', 'id', 'email', 'channel', 'prompt']
const NOT_DETAIL = new Set(['tool', 'tool_use_id', 'agentId', 'hook_event_name', 'session_id', 'transcript_path', 'cwd', 'permission_mode', 'surface'])

function detailOf(input: Record<string, unknown>): string {
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return clip(/[\\/]/.test(value) && !/^https?:/i.test(value) ? leaf(value) : value)
    if (typeof value === 'number') return String(value)
  }
  for (const [key, value] of Object.entries(input)) {
    if (!NOT_DETAIL.has(key) && typeof value === 'string' && value.trim()) return clip(value)
  }
  return ''
}

/** How a call ended: absent outcome when it went through. */
type Ending = { outcome?: Outcome; error?: string }

// What a refusal reads like once stored as an error: the person's at the permission prompt, a hook's, a policy's.
const BLOCKED = /doesn't want to (proceed|take this action)|tool use was rejected|(denied|blocked|refused) by (the )?(user|person|hook|policy|permission)|permission to use [^.]* (was|has been) denied/i

/** How a call ended, from what `tool.call` answered or what the transcript stored for it. */
function endingOf(ran: unknown): Ending {
  const got = (ran ?? {}) as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown }
  if (typeof got.deny === 'string') return { outcome: 'blocked', error: firstLine(got.deny) }
  if (got.isError !== true) return {}
  const text = typeof got.text === 'string' ? got.text : typeof got.result === 'string' ? got.result : ''
  return { outcome: BLOCKED.test(text) ? 'blocked' : 'failed', ...(text ? { error: firstLine(text) } : {}) }
}

type Hit =
  | { kind: 'connector'; key: string; name: string; named: boolean; server?: string; call: Omit<Call, 'at'> }
  | { kind: 'file'; path: string; edited: boolean }
  | { kind: 'skill'; name: string }
  | { kind: 'site'; host: string; call: Omit<Call, 'at'> }
  | { kind: 'search'; call: Omit<Call, 'at'> }

const skillOfPath = (path: string) => /\/([^/]+)\/SKILL\.md$/i.exec(path)?.[1] ?? ''
// Claude's own spill files and scratch copies are not files the chat was given.
const isScratch = (path: string) => /\/tool-results\/|\/AppData\/Local\/Temp\/|^\/tmp\/|\/\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\//i.test(path)

// ---- Pages a browser went to ----

/** The browsers whose page visits count as web, each with the word its page rows show. */
const BROWSERS: Record<string, string> = { claude_browser: 'browser', 'claude-in-chrome': 'chrome' }
/** Steps that only go to a page or read it. A browser call made of these alone is web, not a connector's. */
const PAGE_STEPS = new Set(['navigate', 'preview_start', 'get_page_text', 'read_page', 'find', 'tabs_context', 'tabs_context_mcp'])
/** `computer` actions that only look at the page. */
const LOOKS = new Set(['screenshot', 'zoom', 'scroll', 'scroll_to', 'wait', 'hover'])
const WEB_URL = /^https?:\/\//i

type BrowserStep = { name: string; input: Record<string, unknown> }

/** A page on the person's own machine: a preview of their app, not the web. */
function isLocal(url: string): boolean {
  const host = (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(url)?.[1] ?? '').toLowerCase()
  return host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host) || /\.(localhost|test)$/.test(host)
}

/** The steps of one browser call: a batch's actions, or the call itself. */
function browserStepsOf(name: string, input: Record<string, unknown>): BrowserStep[] {
  if (name !== 'browser_batch') return [{ name, input }]
  return (Array.isArray(input.actions) ? input.actions : []).map(one => {
    const step = (one ?? {}) as { name?: unknown; input?: unknown }
    return { name: str(step.name), input: (step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown> }
  })
}

/** Each step's own part of what the call answered. A batch opens each part with "[name] ", in step order. */
function partsOf(text: string, steps: readonly BrowserStep[], isBatch: boolean): string[] {
  if (!isBatch) return [text]
  const starts: number[] = []
  let from = 0
  for (const step of steps) {
    const at = text.indexOf(`[${step.name}] `, from)
    // A batch stops at its first error, so later steps have no part.
    if (at < 0) break
    starts.push(at)
    from = at + step.name.length + 3
  }
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length))
}

/** The page a step's part says its tab ended on, after any redirect; '' when it names none. */
function landedIn(part: string): string {
  // "Executed on tabId: seed" names the tab, and its line in the tab list ends with its address: ("https://...").
  const tab = /Executed on tabId: (\S+)/.exec(part)?.[1]
  if (tab) {
    const row = part.split('\n').find(line => line.includes(`tabId ${tab}: `))
    const url = row ? (/\("([^"]+)"\)\s*$/.exec(row)?.[1] ?? '') : ''
    if (WEB_URL.test(url)) return url
  }
  const said = /^URL: (\S+)/m.exec(part)?.[1] ?? /navigated to (\S+)/.exec(part)?.[1] ?? ''
  return WEB_URL.test(said) ? said : ''
}

/** What a browser call did on the web: the pages it went to, and whether it also used the browser for more than that. */
function visitsOf(name: string, input: Record<string, unknown>, text: string): { pages: string[]; isOnlyPages: boolean } {
  const steps = browserStepsOf(name, input)
  const parts = partsOf(text, steps, name === 'browser_batch')
  const pages: string[] = []
  steps.forEach((step, i) => {
    if (step.name !== 'navigate' && step.name !== 'preview_start') return
    const asked = str(step.input.url)
    if (!asked) return
    // A step whose own part names no page (the one that opened the pane) takes the page the next step read.
    const next = steps[i + 1]
    const read = next && next.name !== 'navigate' && next.name !== 'preview_start' ? landedIn(parts[i + 1] ?? '') : ''
    const page = landedIn(parts[i] ?? '') || read || (WEB_URL.test(asked) ? asked : '')
    if (page && !isLocal(page) && !pages.includes(page)) pages.push(page)
  })
  const isPageStep = (step: BrowserStep) => PAGE_STEPS.has(step.name) || (step.name === 'computer' && LOOKS.has(str(step.input.action)))
  return { pages, isOnlyPages: steps.length > 0 && steps.every(isPageStep) }
}

/** The text of a call's answer, live or from the transcript. */
const answerText = (ran: unknown) => {
  const text = (ran as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

/** What one call used. `text` is its answer, where the page a browser landed on is read. */
function hitsOf(tool: string, input: Record<string, unknown>, text = ''): Hit[] {
  if (PLAN_TOOLS.has(tool)) return []
  if (tool.startsWith('mcp__')) {
    // A browser's page visits are web: one page row each, under the site it landed on.
    const [, server = '', ...rest] = tool.split('__')
    const via = BROWSERS[server.toLowerCase()]
    const visits = via ? visitsOf(rest.join('__'), input, text) : undefined
    const sites: Hit[] = (visits?.pages ?? []).map(url => ({ kind: 'site', host: hostOf(url), call: { tool: via!, detail: url, cli: false } }))
    // Going to pages and reading them is all web; clicks, typing and local previews stay on the browser's connector row.
    if (sites.length && visits?.isOnlyPages) return sites
    // An MCP tool is a connector's, or the app's own and not counted.
    const connector = connectorOf(tool)
    if (!connector) return sites
    const { key, name, named, server: id } = connector
    return [...sites, { kind: 'connector', key, name, named, ...(id ? { server: id } : {}), call: { tool: plainTool(connector.tool, name), detail: detailOf(input), cli: false } }]
  }
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    return cliCalls(input.command).map(call => ({ kind: 'connector' as const, key: slug(call.name), name: call.name, named: true, call: { tool: call.tool, detail: clip(call.detail), cli: true } }))
  }
  if (tool === 'WebFetch') {
    const url = str(input.url)
    return url ? [{ kind: 'site', host: hostOf(url), call: { tool: 'fetch', detail: url, cli: false } }] : []
  }
  if (tool === 'WebSearch') {
    const query = str(input.query)
    return query ? [{ kind: 'search', call: { tool: 'search', detail: clip(query, 120), cli: false } }] : []
  }
  const target = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (!target) return tool === 'Skill' && typeof input.skill === 'string' && input.skill ? [{ kind: 'skill', name: input.skill.replace(/^\//, '') }] : []
  const path = canon(target)
  if (tool === 'Read') {
    // A skill file read on purpose is a skill, named for its folder.
    const skill = skillOfPath(path)
    if (skill) return [{ kind: 'skill', name: skill }]
    return isScratch(path) ? [] : [{ kind: 'file', path, edited: false }]
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return isScratch(path) ? [] : [{ kind: 'file', path, edited: true }]
  return []
}

type Stamped = { hit: Hit; seq: number; at: number; ms?: number; ending: Ending }

/** One call as a row keeps it. */
const callOf = (call: Omit<Call, 'at'>, { at, ms, ending }: Stamped): Call => ({
  ...call,
  at,
  ...(ms !== undefined ? { ms } : {}),
  ...(ending.outcome ? { outcome: ending.outcome } : {}),
  ...(ending.error ? { error: ending.error } : {}),
})

function addSkill(rows: Skill[], name: string, at: number, always: boolean): Skill[] {
  const old = rows.find(row => row.name === name)
  const rest = rows.filter(row => row.name !== name)
  if (always) return [...rest, { name, count: old?.count ?? 0, seq: old?.seq ?? at, always: true }]
  return [...rest, { name, count: (old?.count ?? 0) + 1, seq: at, always: old?.always ?? false }]
}

function apply(list: Inventory, hits: readonly Stamped[]): Inventory {
  let { connectors, files, skills, sites, searches } = list
  for (const stamp of hits) {
    const { hit, seq: order, ending } = stamp
    const failed = ending.outcome === 'failed' ? 1 : 0
    const blocked = ending.outcome === 'blocked' ? 1 : 0
    if (hit.kind === 'connector') {
      const { key } = hit
      const old = connectors.find(row => row.key === key)
      // The first real name stays; the "Connector 1a59" stand-in gives way to a name learned later.
      const row: Connector = {
        key,
        name: old?.named ? old.name : hit.name,
        named: (old?.named ?? false) || hit.named,
        ...(hit.server ? { server: hit.server } : {}),
        count: (old?.count ?? 0) + 1,
        failed: (old?.failed ?? 0) + failed,
        blocked: (old?.blocked ?? 0) + blocked,
        seq: order,
        cli: (old?.cli ?? false) || hit.call.cli,
        mcp: (old?.mcp ?? false) || !hit.call.cli,
        calls: [...(old?.calls ?? []), callOf(hit.call, stamp)].slice(-MAX_CALLS),
      }
      connectors = [...connectors.filter(one => one.key !== key), row]
    } else if (hit.kind === 'site') {
      const old = sites.find(row => row.host === hit.host)
      const row: Site = {
        host: hit.host,
        count: (old?.count ?? 0) + 1,
        failed: (old?.failed ?? 0) + failed,
        blocked: (old?.blocked ?? 0) + blocked,
        seq: order,
        calls: [...(old?.calls ?? []), callOf(hit.call, stamp)].slice(-MAX_CALLS),
      }
      sites = [...sites.filter(one => one.host !== hit.host), row]
    } else if (hit.kind === 'search') {
      searches = [...searches, callOf(hit.call, stamp)].slice(-MAX_SEARCHES)
    } else if (hit.kind === 'skill') {
      if (!ending.outcome) skills = addSkill(skills, hit.name, order, false)
    } else {
      // One row per file however its path is spelled; the row keeps the first spelling seen.
      const key = fileKey(hit.path)
      const old = files.find(row => fileKey(row.path) === key)
      const row: FileEntry = {
        path: old?.path ?? hit.path,
        memory: old?.memory ?? false,
        edited: (old?.edited ?? false) || (hit.edited && !ending.outcome),
        ok: (old?.ok ?? false) || !ending.outcome,
        failed: (old?.failed ?? 0) + failed,
        blocked: (old?.blocked ?? 0) + blocked,
        seq: order,
      }
      files = [...files.filter(one => fileKey(one.path) !== key), row]
    }
  }
  return { ...list, connectors, files, skills, sites, searches }
}

// ---- Subagents ----

/** A new subagent row; empty parts take the defaults. */
function newAgent(parts: Partial<Agent> & { callId: string }): Agent {
  const given = Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== '' && value !== undefined)) as Partial<Agent>
  return { callId: parts.callId, id: '', type: 'general-purpose', task: 'Subagent', model: '', startedAt: 0, endedAt: 0, tools: 0, counted: true, seq: (seq += 1), ...given }
}

/** The subagent row that matches the call or the loop id, changed, or made and changed when there is none. */
function upsertAgent(rows: readonly Agent[], match: { callId?: string; id?: string }, make: () => Agent, change: (row: Agent) => Agent): Agent[] {
  const at = rows.findIndex(row => (!!match.callId && row.callId === match.callId) || (!!match.id && row.id === match.id))
  if (at < 0) return [...rows, change(make())].slice(-MAX_AGENTS)
  return rows.map((row, i) => (i === at ? change(row) : row))
}

/** A subagent's creds: Claude Code's own figure where it has one, else counted from its requests by the table; undefined before its id is known. */
const credsOfAgent = (spend: Spend) => (row: Agent) => {
  if (!row.id) return undefined
  const usd = spend.agentUsd?.[row.id]
  return usd !== undefined ? usd / DOLLARS_PER_CRED : spend.byAgent[row.id]
}

/** Each subagent's cost by Claude Code's own estimate, kept as it grows: the engine forgets them when the process ends. */
async function readAgentCosts($: EngineInterface) {
  const costs = (await $.agent.list().catch(() => []))
    .map(agent => [agent.id, agent.cost?.usd] as const)
    .filter((one): one is readonly [string, number] => typeof one[1] === 'number' && one[1] > 0)
  if (!costs.length) return
  await update($, spendAtom, spend => {
    const agentUsd = { ...(spend.agentUsd ?? {}) }
    let isChanged = false
    for (const [id, usd] of costs) {
      if (usd <= (agentUsd[id] ?? 0)) continue
      agentUsd[id] = usd
      isChanged = true
    }
    return isChanged ? { ...spend, agentUsd } : spend
  })
}

// ---- Context cost ----

/** What is loaded into every message, what is unused of it, and what both cost. */
function costsOf(list: Inventory, weights: Weights, spend: Spend) {
  const model = weights.model
  const perMessage = (tokens: number) => readCreds(model, tokens)
  const usedConnectors = new Set(list.connectors.map(row => `c:${row.key}`))
  const usedSkills = new Set(list.skills.filter(row => row.count > 0).map(row => row.name))
  const nameOfWeight = (weight: Weight) => {
    const row = list.connectors.find(one => `c:${one.key}` === weight.key)
    const server = weight.key.startsWith('c:id-') ? weight.key.slice(5) : ''
    return (server && ownNameOf(server)) || (row?.named ? row.name : weight.name)
  }
  const connectors = weights.connectors
    .map(weight => ({ ...weight, name: nameOfWeight(weight), isUnused: !usedConnectors.has(weight.key) }))
    .sort((a, b) => Number(b.isUnused) - Number(a.isUnused) || b.tokens - a.tokens)
  const skills = weights.skills.map(weight => ({ ...weight, isUnused: !usedSkills.has(weight.name) })).sort((a, b) => Number(b.isUnused) - Number(a.isUnused) || b.tokens - a.tokens)
  const unused = [...connectors.filter(one => one.isUnused), ...skills.filter(one => one.isUnused)]
  const soFar = (keys: readonly string[]) => keys.reduce((sum, key) => sum + (spend.carried[key] ?? 0), 0)
  const allTokens = total(weights.connectors) + total(weights.skills) + total(weights.files)
  return {
    model,
    perMessage,
    connectors,
    skills,
    unusedSkills: skills.filter(one => one.isUnused).length,
    allTokens,
    allSoFar: Object.values(spend.carried).reduce((sum, n) => sum + n, 0),
    unusedTokens: total(unused),
    unusedSoFar: soFar(unused.map(one => one.key)),
    soFar,
  }
}

/** A creds figure: under one shows as "<1", not "0". */
const credsText = (n: number) => (n > 0 && n < 1 ? '<1' : amount(n))

/** What one skill has cost this chat, by part. */
type SkillCost = {
  /** Its instructions while the context carried them: from the transcripts, or, loaded at the start, as a memory file. */
  body: number
  tokens: number
  loads: number
  requests: number
  /** Its line in the skill list every request carries, since the mod loaded. */
  listing: number
  listingTokens: number
  /** Both together. */
  total: number
  /** The turns it was used in, and all they cost. */
  turns: number
  turnCreds: number
}

/** One skill's creds by part. */
function skillCostOf(skill: Skill, weights: Weights, spend: Spend, stats: SessionStats): SkillCost {
  const listingKey = `s:${skill.name}`
  const listing = spend.carried[listingKey] ?? 0
  const carried = (stats.skills ?? {})[skill.name] ?? NO_SKILL_SPEND
  // A skill loaded at the start through a memory file rides along as that file.
  const name = skill.name.toLowerCase()
  const memory = skill.always ? weights.files.find(one => skillOfPath(one.key.slice(2)).toLowerCase() === name) : undefined
  const body = carried.creds + (memory ? (spend.carried[memory.key] ?? 0) : 0)
  return {
    body,
    tokens: carried.tokens || memory?.tokens || 0,
    loads: carried.loads,
    requests: carried.requests + (memory ? spend.requests : 0),
    listing,
    listingTokens: weights.skills.find(one => one.key === listingKey)?.tokens ?? 0,
    total: body + listing,
    turns: carried.turns,
    turnCreds: carried.turnCreds,
  }
}

// ---- Session stats ----

type LogEntry = Record<string, unknown> & { message?: { id?: unknown; model?: unknown; usage?: Usage; content?: unknown } }
type Request = { at: number; used: Usage; isSub: boolean }

/** A transcript's entries, in file order; a line still being written, or any other that is not JSON, is skipped. */
function entriesOf(text: string): LogEntry[] {
  const rows: LogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      rows.push(JSON.parse(line) as LogEntry)
    } catch {
      // Not a whole entry.
    }
  }
  return rows
}

/** What the person typed, short: a slash command by its name, an image alone as "an image". */
function promptText(content: unknown): string {
  const blocks = Array.isArray(content) ? (content as { type?: unknown; text?: unknown }[]) : []
  const raw = typeof content === 'string' ? content : blocks.filter(block => block?.type === 'text').map(block => str(block.text)).join('\n')
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
  const typed = SLASH.exec(text)
  if (typed) return `/${typed[1] ?? typed[2]}`
  return clip(text, 48) || (blocks.some(block => block?.type === 'image') ? 'an image' : 'a prompt')
}

// ---- What each skill's instructions cost ----

/** A message's or tool result's text: a string, or its text blocks joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

/** About four characters to a token: a skill's instructions are counted from their length. */
const tokensOfText = (text: string) => Math.ceil(text.length / 4)

/** A skill's use as one transcript shows it: its instructions loading, at this time. */
type SkillUse = { name: string; at: number }

/** What the skill scan of one transcript remembers from one read of it to the next. */
type SkillScan = {
  /** Skill calls and SKILL.md reads by their call id. */
  calls: Map<string, { name: string; isRead: boolean }>
  /** Slash commands the person typed, by their entry's id. */
  commands: Map<string, string>
  /** Requests already priced, by id: one request is stored as several lines. */
  counted: Set<string>
  /** The instructions the context holds now. */
  active: { name: string; tokens: number; reach: number; requests: number }[]
  /** The size of the last request sent: what comes before anything loaded after it. */
  lastPrompt: number
}
const newSkillScan = (): SkillScan => ({ calls: new Map(), commands: new Map(), counted: new Set(), active: [], lastPrompt: 0 })

/**
 * Walks what one transcript gained, in file order, for the skills whose instructions it loaded and the
 * requests that carried them; `scan` carries what earlier reads of the same file left off with. Instructions load when the Skill tool runs (a note the engine files under the call's id),
 * when the person types the skill as a slash command (a note after the command), when Claude reads a
 * SKILL.md, and again after a compaction that keeps them. Once loaded they go out with every request until
 * the next compaction: the first request after the load writes them to the cache, and a later one reads
 * them from it if it read at least as far as they reach, else writes them again.
 */
function carrySkills(entries: readonly LogEntry[], isSub: boolean, into: Map<string, SkillSpend>, uses: SkillUse[], scan: SkillScan) {
  const { calls, commands, counted } = scan
  const load = (name: string, body: string, at: number, isUse: boolean) => {
    if (!name || !body.trim()) return
    const tokens = tokensOfText(body)
    scan.active.push({ name, tokens, reach: scan.lastPrompt + tokens, requests: 0 })
    const row = into.get(name) ?? NO_SKILL_SPEND
    into.set(name, { ...row, tokens: Math.max(row.tokens, tokens), loads: row.loads + 1 })
    if (isUse && Number.isFinite(at)) uses.push({ name, at })
  }
  for (const entry of entries) {
    // A main transcript's sidechain lines are a subagent's own context.
    if (!isSub && entry.isSidechain === true) continue
    const at = Date.parse(str(entry.timestamp))
    const message: NonNullable<LogEntry['message']> = entry.message && typeof entry.message === 'object' ? entry.message : {}
    const blocks = (Array.isArray(message.content) ? message.content : []) as Record<string, unknown>[]
    if (entry.type === 'system') {
      // A compaction leaves only its summary, and what the engine attaches again after it.
      if (entry.subtype === 'compact_boundary') {
        scan.active = []
        scan.lastPrompt = 0
      }
      continue
    }
    if (entry.type === 'attachment') {
      const attached = (entry.attachment ?? {}) as { type?: unknown; skills?: unknown }
      if (attached.type === 'invoked_skills' && Array.isArray(attached.skills)) {
        for (const one of attached.skills as { name?: unknown; content?: unknown }[]) load(str(one?.name).replace(/^\//, ''), typeof one?.content === 'string' ? one.content : '', at, false)
      }
      continue
    }
    if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
        if (block.name === 'Skill' && str(input.skill)) calls.set(block.id, { name: str(input.skill).replace(/^\//, ''), isRead: false })
        const read = block.name === 'Read' ? skillOfPath(slashes(str(input.file_path))) : ''
        if (read) calls.set(block.id, { name: read, isRead: true })
      }
      // One request is stored as one line per content block, each with the same usage: counted once.
      const id = str(message.id) || str(entry.requestId)
      const used = message.usage
      if (!id || !used || typeof used !== 'object' || counted.has(id)) continue
      counted.add(id)
      const read = used.cache_read_input_tokens || 0
      const prompt = (used.input_tokens || 0) + read + (used.cache_creation_input_tokens || 0)
      if (!prompt) continue
      const model = str(message.model)
      for (const one of scan.active) {
        const isRead = one.requests > 0 && read >= one.reach
        const creds = isRead ? readCreds(model, one.tokens, prompt) : writeCreds(model, one.tokens, prompt, isSub)
        one.requests += 1
        const row = into.get(one.name) ?? NO_SKILL_SPEND
        into.set(one.name, { ...row, requests: row.requests + 1, creds: row.creds + creds })
      }
      scan.lastPrompt = prompt
      continue
    }
    if (entry.type !== 'user') continue
    const text = textOfContent(message.content)
    const typed = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(text)?.[1]
    if (typed && str(entry.uuid)) commands.set(str(entry.uuid), typed)
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue
      const call = calls.get(str(block.tool_use_id))
      if (!call || block.is_error === true) continue
      const body = textOfContent(block.content)
      // A SKILL.md read is its instructions; the Skill tool's own answer only says the skill launched.
      if (call.isRead || /^Base directory for this skill:/.test(body.trimStart())) load(call.name, body, at, true)
    }
    if (entry.isMeta !== true) continue
    const source = str(entry.sourceToolUseID)
    const name = source ? (calls.get(source)?.isRead ? '' : calls.get(source)?.name) : commands.get(str(entry.parentUuid))
    if (name) load(name, text, at, true)
  }
}

/** What the transcripts have held so far, gathered as they are read, so a refresh adds only what was written since. */
type Facts = {
  requests: Map<string, Request>
  tools: Set<string>
  prompts: { at: number; text: string }[]
  starts: number[]
  busy: number[]
  /** Each skill's instructions carried, and its uses. */
  carried: Map<string, SkillSpend>
  uses: SkillUse[]
  /** When each tool call in the main transcript was made, by its id. */
  times: Map<string, number>
}
const newFacts = (): Facts => ({ requests: new Map(), tools: new Set(), prompts: [], starts: [], busy: [], carried: new Map(), uses: [], times: new Map() })

/**
 * Adds what one transcript gained to the facts. A turn starts at the person's prompt or another
 * session's message (a subagent reporting back), and lasts until the last request, tool result or
 * turn-end note before the next one.
 */
function collect(entries: readonly LogEntry[], tail: Tail, facts: Facts) {
  carrySkills(entries, tail.isSub, facts.carried, facts.uses, tail.skills)
  for (const entry of entries) {
    const at = Date.parse(str(entry.timestamp))
    if (!Number.isFinite(at)) continue
    const isSub = tail.isSub || entry.isSidechain === true
    const message: NonNullable<LogEntry['message']> = entry.message && typeof entry.message === 'object' ? entry.message : {}
    const blocks = (Array.isArray(message.content) ? message.content : []) as { type?: unknown; id?: unknown }[]
    if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        facts.tools.add(block.id)
        if (!tail.isSub) facts.times.set(block.id, at)
      }
      // One request is stored as one line per content block, each with the same usage.
      const id = str(message.id) || str(entry.requestId)
      if (id && message.usage && typeof message.usage === 'object') {
        facts.requests.set(id, { at: facts.requests.get(id)?.at ?? at, used: { ...message.usage, model: str(message.model) }, isSub })
      }
      if (!isSub) facts.busy.push(at)
    } else if (isSub) {
      continue
    } else if (entry.type === 'user') {
      if (blocks.some(block => block?.type === 'tool_result')) {
        facts.busy.push(at)
        continue
      }
      const kind = str((entry.origin as { kind?: unknown } | undefined)?.kind)
      if (kind || entry.isMeta !== true) facts.starts.push(at)
      if (kind === 'human' || (!kind && entry.isMeta !== true)) facts.prompts.push({ at, text: promptText(message.content) })
    } else if (entry.type === 'system') {
      facts.busy.push(at)
    }
  }
}

/**
 * The Session card's figures from the facts the transcripts gave. Each request's creds go to the
 * person's latest answered prompt, so a prompt's figure holds its subagents' work.
 */
function statsFrom(facts: Facts): Omit<SessionStats, 'at' | 'source'> {
  const { tools, carried, uses } = facts
  const byTime = (a: number, b: number) => a - b
  const starts = [...facts.starts].sort(byTime)
  const busy = [...facts.busy].sort(byTime)
  const prompts = [...facts.prompts].sort((a, b) => a.at - b.at)
  const all = [...facts.requests.values()].sort((a, b) => a.at - b.at)
  const main = all.filter(one => !one.isSub)

  // Working time: each turn from its start to the last sign of work before the next one. Both lists
  // are in time order, so one pass over each.
  let workingMs = 0
  let b = 0
  starts.forEach((start, i) => {
    const next = starts[i + 1] ?? Infinity
    let end = start
    while (b < busy.length && busy[b]! < start) b += 1
    while (b < busy.length && busy[b]! < next) {
      end = Math.max(end, busy[b]!)
      b += 1
    }
    workingMs += end - start
  })

  // A prompt Claude answered has a main-chat request in its own turn; a slash command answered locally has none.
  let s = 0
  let m = 0
  const answered = prompts.filter(prompt => {
    while (s < starts.length && starts[s]! <= prompt.at) s += 1
    const next = starts[s] ?? Infinity
    while (m < main.length && main[m]!.at < prompt.at) m += 1
    return m < main.length && main[m]!.at < next
  })
  const spent = answered.map(() => 0)
  const tokens = { read: 0, write: 0, fresh: 0 }
  const creds = { read: 0, write: 0, fresh: 0, output: 0 }
  let owner = -1
  for (const one of all) {
    while (owner + 1 < answered.length && answered[owner + 1]!.at <= one.at) owner += 1
    const kinds = credsByKind(one.used, one.isSub)
    const sum = kinds.fresh + kinds.read + kinds.write + kinds.output
    if (owner >= 0) spent[owner] = (spent[owner] ?? 0) + sum
    tokens.read += one.used.cache_read_input_tokens || 0
    tokens.write += one.used.cache_creation_input_tokens || 0
    tokens.fresh += one.used.input_tokens || 0
    creds.read += kinds.read
    creds.write += kinds.write
    creds.fresh += kinds.fresh
    creds.output += kinds.output
  }

  // A cold send: the cache served under half of what the previous request on the same model sent, though
  // this one sends nearly as much (a compaction sends far less) and is big enough to matter.
  const cold = { count: 0, creds: 0 }
  let before: { size: number; model: string } | undefined
  for (const one of main) {
    const read = one.used.cache_read_input_tokens || 0
    const size = (one.used.input_tokens || 0) + read + (one.used.cache_creation_input_tokens || 0)
    if (!size) continue
    const model = str(one.used.model)
    if (before && model === before.model && size >= COLD_MIN_TOKENS && size >= 0.8 * before.size && read < 0.5 * before.size) {
      cold.count += 1
      cold.creds += weigh(one.used, false)
    }
    before = { size, model }
  }

  let top = -1
  spent.forEach((sum, i) => {
    if (top < 0 || sum > spent[top]!) top = i
  })

  // Each skill's turns: the answered prompts whose turns loaded it, a compaction's reload aside.
  const skills: Record<string, SkillSpend> = {}
  for (const name of new Set([...carried.keys(), ...uses.map(use => use.name)])) {
    const owners = new Set<number>()
    for (const use of uses) {
      if (use.name !== name) continue
      let owner = -1
      answered.forEach((prompt, i) => {
        if (prompt.at <= use.at) owner = i
      })
      if (owner >= 0) owners.add(owner)
    }
    skills[name] = { ...(carried.get(name) ?? NO_SKILL_SPEND), turns: owners.size, turnCreds: [...owners].reduce((sum, i) => sum + (spent[i] ?? 0), 0) }
  }
  return {
    prompts: answered.length,
    requests: all.length,
    tools: tools.size,
    workingMs,
    tokens,
    creds,
    cold,
    priciest: top >= 0 && spent[top]! > 0 ? { creds: spent[top]!, text: answered[top]!.text } : { creds: 0, text: '' },
    promptCreds: spent.reduce((sum, n) => sum + n, 0),
    skills,
  }
}

/** A stretch of time: 42s, 3m 05s, 1h 12m. */
const span = (ms: number) => (ms < 1000 ? '0s' : took(ms))

type StatRow = { key: string; label: string; value: string; note?: string }

/** The Session card's rows, for the pane and the copied summary alike. The total comes from the ledger where there is one. */
function sessionRows(stats: SessionStats, ledgerUsd: number, startedAt: number, now: number): StatRow[] {
  const kinds = stats.creds
  const estimate = kinds.read + kinds.write + kinds.fresh + kinds.output
  const whole = ledgerUsd >= 0 ? ledgerUsd / DOLLARS_PER_CRED : estimate
  const rows: StatRow[] = [{ key: 'spent', label: 'Total spent', value: `≈${amount(whole)} creds · $${(whole * DOLLARS_PER_CRED).toFixed(2)}` }]
  const open = startedAt > 0 && now > startedAt ? `open ${span(now - startedAt)} · ` : ''
  rows.push({ key: 'time', label: 'Time', value: `${open}working ${span(stats.workingMs)}` })
  if (!stats.requests) return rows
  rows.push({ key: 'activity', label: 'Activity', value: [count(stats.prompts, 'prompt'), count(stats.requests, 'request'), count(stats.tools, 'tool call')].join(' · ') })
  const input = stats.tokens.read + stats.tokens.write + stats.tokens.fresh
  if (input) rows.push({ key: 'hits', label: 'Cache hit rate', value: `${Math.round((100 * stats.tokens.read) / input)}% read from cache` })
  if (estimate) {
    const share = (n: number) => Math.round((100 * n) / estimate)
    const fresh = share(kinds.fresh)
    rows.push({
      key: 'went',
      label: 'Where creds went',
      value: [`reading ${share(kinds.read)}%`, `writing ${share(kinds.write)}%`, `output ${share(kinds.output)}%`, fresh >= 1 ? `new input ${fresh}%` : ''].filter(Boolean).join(' · '),
    })
  }
  rows.push({ key: 'cold', label: 'Cold sends', value: stats.cold.count ? `${stats.cold.count} · ≈${amount(stats.cold.creds)} creds` : 'none' })
  if (stats.priciest.creds) rows.push({ key: 'priciest', label: 'Priciest prompt', value: `≈${amount(stats.priciest.creds)} creds`, note: `“${stats.priciest.text}”` })
  if (stats.prompts) rows.push({ key: 'average', label: 'Average per prompt', value: `≈${amount(stats.promptCreds / stats.prompts)} creds` })
  return rows
}

// ---- The to-do list ----

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (value: unknown): Step['status'] => (typeof value === 'string' && STATUSES.has(value) ? (value as Step['status']) : 'pending')
const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function stepsOf(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []
  const steps: Step[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const one = item as Record<string, unknown>
    const text = textOf(one.content) || textOf(one.text)
    if (!text) continue
    const active = textOf(one.activeForm)
    steps.push({ text, status: statusOf(one.status), ...(active ? { active } : {}) })
  }
  return steps
}

/** The list after one call to a list tool, or undefined when the call changes nothing. */
function planAfter(now: Plan, tool: string, input: Record<string, unknown>, result: unknown, at: number): Plan | undefined {
  if (tool === 'TodoWrite') return { title: now.title, steps: stepsOf(input.todos), updatedAt: at }
  if (tool === DESKTOP_PLAN) {
    if (Array.isArray(input.items)) return { title: '', steps: stepsOf(input.items), updatedAt: at }
    let steps = now.steps
    if (input.advance === true) {
      // The running step is done and the next waiting one starts.
      const running = steps.findIndex(step => step.status === 'in_progress')
      steps = steps.map((step, i) => (i === running ? { ...step, status: 'completed' as const } : step))
      const waiting = steps.findIndex(step => step.status === 'pending')
      steps = steps.map((step, i) => (i === waiting ? { ...step, status: 'in_progress' as const } : step))
    }
    // "done" and "start" count steps from 1.
    const done = Array.isArray(input.done) ? input.done.filter((n): n is number => typeof n === 'number') : []
    if (done.length) steps = steps.map((step, i) => (done.includes(i + 1) ? { ...step, status: 'completed' as const } : step))
    if (typeof input.start === 'number') steps = steps.map((step, i) => (i + 1 === input.start ? { ...step, status: 'in_progress' as const } : step))
    return steps === now.steps ? undefined : { ...now, steps, updatedAt: at }
  }
  if (tool === DESKTOP_WRAP) {
    // Wrapping up closes the task: the desktop app checks off the whole list, steps never started included.
    if (!now.steps.some(step => step.status !== 'completed')) return undefined
    return { ...now, steps: now.steps.map(step => ({ ...step, status: 'completed' as const })), updatedAt: at }
  }
  if (tool === 'TaskCreate') {
    const text = textOf(input.subject)
    if (!text) return undefined
    const made = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const id = typeof made === 'string' || typeof made === 'number' ? String(made) : String(now.steps.length + 1)
    const active = textOf(input.activeForm)
    return { ...now, steps: [...now.steps, { text, status: 'pending', id, ...(active ? { active } : {}) }], updatedAt: at }
  }
  if (tool === 'TaskUpdate') {
    const id = typeof input.taskId === 'number' ? String(input.taskId) : textOf(input.taskId)
    const index = now.steps.findIndex(step => step.id === id)
    const old = now.steps[index]
    if (!old) return undefined
    if (input.status === 'deleted') return { ...now, steps: now.steps.filter((_, i) => i !== index), updatedAt: at }
    const active = textOf(input.activeForm) || old.active
    const changed: Step = {
      ...old,
      text: textOf(input.subject) || old.text,
      status: input.status === undefined ? old.status : statusOf(input.status),
      ...(active ? { active } : {}),
    }
    return { ...now, steps: now.steps.map((step, i) => (i === index ? changed : step)), updatedAt: at }
  }
  return undefined
}

// ---- Reading the chat ----

const envText = async (value: Promise<unknown>) => {
  const got = await value.catch(() => undefined)
  return typeof got === 'string' ? got.trim() : ''
}

async function locate($: EngineInterface) {
  const profile = await envText($.env.get('USERPROFILE'))
  const set = await envText($.env.get('CLAUDE_CONFIG_DIR'))
  home = slashes(profile).replace(/\/+$/, '')
  configDir = set ? slashes(set).replace(/\/+$/, '') : `${home}/.claude`
  // Windows may spell the home folder by its 8.3 short name (C:/Users/SHREYA~1), as TEMP usually does.
  const aliases = new Set<string>()
  for (const temp of [await envText($.env.get('TEMP')), await envText($.env.get('TMP'))]) {
    const base = /^(.+)\/AppData\/Local\/Temp\/?$/i.exec(slashes(temp))?.[1]
    if (home && base && base.includes('~') && base.toLowerCase() !== home.toLowerCase()) aliases.add(base)
  }
  homeAliases = [...aliases]
}

async function log($: EngineInterface, where: string, err: unknown) {
  try {
    const path = `${configDir}/chat-monitor.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const line = `${new Date(await $.clock.now()).toISOString()} ${where}: ${String(err instanceof Error ? err.message : err)}`
    await $.fs.write(path, `${[...old.split('\n').filter(Boolean), line].slice(-200).join('\n')}\n`)
  } catch {
    // Nowhere left to report it.
  }
}

/**
 * Runs a recording job after the hook that asked for it has returned, in the order asked: a tool
 * call's result goes back to Claude at once, and the pane catches up a moment later.
 */
function later($: EngineInterface, where: string, job: () => Promise<unknown>) {
  try {
    $.clock.after(0, () => {
      chain = chain.then(job).then(
        () => undefined,
        err => log($, where, err),
      )
    })
  } catch (err) {
    void log($, where, err)
  }
}

/** Keeps the transcript's real path, which every settings-hook event carries. */
async function notePath($: EngineInterface, e: { transcript_path?: unknown }) {
  const path = typeof e.transcript_path === 'string' ? e.transcript_path.trim() : ''
  if (!path || (await read($, metaAtom)).transcript === path) return
  await update($, metaAtom, meta => ({ ...meta, transcript: path }))
}

/** This chat's transcript file: the path the settings hooks gave, else found by the chat's id; '' when none is found. */
async function transcriptPath($: EngineInterface): Promise<string> {
  const known = (await read($, metaAtom)).transcript
  if (known && (await $.fs.exists(known))) return known
  const id = await $.session.id()
  const projects = `${configDir}/projects`
  const folder = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  const guess = `${projects}/${folder}/${id}.jsonl`
  if (await $.fs.exists(guess)) return guess
  // Claude Code shortens a long folder name, and a chat that changed folders stays filed under its first:
  // look for the chat's own file in each project folder, the likeliest first, and remember where it was.
  const near = folder.slice(0, 40).toLowerCase()
  const dirs = (await $.fs.list(projects).catch(() => []))
    .filter(entry => entry.kind === 'dir')
    .map(entry => entry.name)
    .sort((a, b) => Number(b.toLowerCase().startsWith(near)) - Number(a.toLowerCase().startsWith(near)))
  for (const dir of dirs) {
    const path = `${projects}/${dir}/${id}.jsonl`
    if (!(await $.fs.exists(path))) continue
    await update($, metaAtom, meta => ({ ...meta, transcript: path }))
    return path
  }
  return ''
}

// ---- Reading the transcripts as they grow ----
//
// A transcript is only ever added to, so each file is read from where the last read stopped, in
// pieces the engine allows (it refuses a read over 4 MiB), and only what is new is parsed. What the
// lines held is kept as facts, which the Session card is worked out from. A file that got shorter was
// written anew, so every file is read again from the start. A reload of the mod reads them all once.

/** The most of a transcript one read takes: well under the engine's 4 MiB a read. */
const CHUNK = 2 * 1024 * 1024
/** A line longer than this (a huge pasted image, say) is skipped whole rather than held. */
const MAX_LINE = 32 * 1024 * 1024
const NEWLINE = 10

/** One transcript file: how far it has been read, the start of a line not yet ended, and its skill scan. */
type Tail = { path: string; isSub: boolean; offset: number; pending: Uint8Array[]; pendingBytes: number; isSkipping: boolean; skills: SkillScan }
const newTail = (path: string, isSub: boolean): Tail => ({ path, isSub, offset: 0, pending: [], pendingBytes: 0, isSkipping: false, skills: newSkillScan() })

/** The transcripts read so far: module memory, so a reload starts over. */
let reader: { main: string; tails: Map<string, Tail>; facts: Facts } | undefined
/** One catch-up at a time, so no part of a file is read twice. */
let catching: Promise<unknown> = Promise.resolve()

function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

/** Keeps the start of a line whose end has not been read yet, unless the line is too long to keep. */
function hold(tail: Tail, bytes: Uint8Array) {
  if (!bytes.length || tail.isSkipping) return
  if (tail.pendingBytes + bytes.length > MAX_LINE) {
    tail.pending = []
    tail.pendingBytes = 0
    tail.isSkipping = true
    return
  }
  tail.pending.push(bytes.slice())
  tail.pendingBytes += bytes.length
}

/**
 * Reads what one transcript gained since its last read, up to `size` bytes, and adds each piece's
 * whole lines to the facts as it goes, so a read that fails part-way loses nothing already counted.
 * Lines end at a newline byte, so a piece never splits a character of a line it hands on.
 */
async function readMore($: EngineInterface, tail: Tail, size: number, facts: Facts) {
  const decoder = new TextDecoder()
  const parse = (bytes: Uint8Array) => (bytes.length ? entriesOf(decoder.decode(bytes)) : [])
  while (tail.offset < size) {
    const want = Math.min(CHUNK, size - tail.offset)
    const got = await $.fs.read(tail.path, { as: 'bytes', offset: tail.offset, length: want })
    let bytes = bytesOf(got.base64)
    // A host that leaves the range out answers with the whole file: the range is cut from it here.
    if (bytes.length > want) bytes = bytes.subarray(tail.offset, tail.offset + want)
    if (!bytes.length) break
    tail.offset += bytes.length
    const first = bytes.indexOf(NEWLINE)
    if (first < 0) {
      hold(tail, bytes)
      continue
    }
    // The line an earlier piece began ends here.
    const entries = tail.isSkipping ? [] : parse(joined([...tail.pending, bytes.subarray(0, first)]))
    tail.pending = []
    tail.pendingBytes = 0
    tail.isSkipping = false
    const last = bytes.lastIndexOf(NEWLINE)
    if (last > first) entries.push(...parse(bytes.subarray(first + 1, last)))
    hold(tail, bytes.subarray(last + 1))
    if (entries.length) collect(entries, tail, facts)
  }
  // A last line with no newline yet counts once it is whole: a line still being written does not parse.
  if (tail.offset >= size && tail.pendingBytes && !tail.isSkipping) {
    const entries = parse(joined(tail.pending))
    if (entries.length) {
      tail.pending = []
      tail.pendingBytes = 0
      collect(entries, tail, facts)
    }
  }
}

/** Brings the facts up to date with what each file gained; `files` need not name every file read before. */
function catchUp($: EngineInterface, main: string, files: readonly { path: string; size: number; isSub: boolean }[]): Promise<Facts> {
  const run = catching.then(async () => {
    const isRewritten = (state: NonNullable<typeof reader>) => files.some(file => file.size < (state.tails.get(file.path)?.offset ?? 0))
    if (!reader || reader.main !== main || isRewritten(reader)) reader = { main, tails: new Map(), facts: newFacts() }
    const state = reader
    for (const file of files) {
      let tail = state.tails.get(file.path)
      if (!tail) {
        tail = newTail(file.path, file.isSub)
        state.tails.set(file.path, tail)
      }
      await readMore($, tail, file.size, state.facts)
    }
    return state.facts
  })
  catching = run.catch(() => undefined)
  return run
}

/** A file's size and its size and change time as one string; undefined when they cannot be read. */
async function statOf($: EngineInterface, path: string): Promise<{ size: number; stamp: string } | undefined> {
  try {
    const got = await $.fs.stat(path)
    return { size: got.size, stamp: `${got.size}:${got.mtimeMs}` }
  } catch {
    return undefined
  }
}

/**
 * Works the Session card's figures out again from this chat's transcript and its subagents' ones,
 * unless none of those files has changed since the last time; only what they gained is read.
 */
async function readSession($: EngineInterface) {
  const path = await transcriptPath($)
  const at = await $.clock.now()
  if (!path) {
    await update($, sessionAtom, old => (old.at ? old : { ...NO_SESSION, at }))
    return
  }
  // Subagents keep their own transcripts beside the chat's: <chat id>/subagents/agent-<id>.jsonl.
  const folder = `${path.replace(/\.jsonl$/i, '')}/subagents`
  const subs = (await $.fs.list(folder).catch(() => []))
    .map(entry => entry.name)
    .filter(name => /^agent-.+\.jsonl$/i.test(name))
    .sort()
    .map(name => `${folder}/${name}`)
  const files: { path: string; isSub: boolean; size: number; stamp: string }[] = []
  for (const file of [path, ...subs]) {
    const got = await statOf($, file)
    files.push({ path: file, isSub: file !== path, size: got?.size ?? -1, stamp: got?.stamp ?? '' })
  }
  // The chat's own transcript out of reach: keep the figures as they were.
  if (files[0]!.size < 0) return
  const source = files.map(file => `${file.path}:${file.stamp}`).join('|')
  // A file whose size could not be read is looked at again every time.
  if (files.every(file => file.stamp) && (await read($, sessionAtom)).source === source) return
  const facts = await catchUp($, path, files.filter(file => file.size >= 0))
  await update($, sessionAtom, () => ({ ...statsFrom(facts), at, source }))
}

/** When each tool call was made, from this chat's transcript file, read only as far as it is new. */
async function callTimes($: EngineInterface): Promise<Map<string, number>> {
  try {
    const path = await transcriptPath($)
    const got = path ? await statOf($, path) : undefined
    if (!got) return new Map()
    return new Map((await catchUp($, path, [{ path, size: got.size, isSub: false }])).times)
  } catch {
    // Older calls show no time.
    return new Map()
  }
}

/**
 * What the context holds, from Claude Code's local estimate (no request is made): the memory files
 * and skills the chat loaded at the start, and what each connector, skill and memory file adds to
 * every request.
 */
async function readContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const parts = usage.context.breakdown
  if (!parts) return
  for (const skill of parts.skills?.skillFrontmatter ?? []) skillNames.add(skill.name)
  const memory = (parts.memoryFiles ?? []).map(file => ({ path: canon(file.path), tokens: file.tokens ?? 0 })).filter(file => file.path)
  const always = memory.map(file => skillOfPath(file.path)).filter(Boolean)
  const paths = memory.map(file => file.path).filter(path => !skillOfPath(path))
  if (paths.length || always.length) {
    await updateInv($, list => {
      const keys = new Set(paths.map(fileKey))
      const have = new Set(list.files.map(file => fileKey(file.path)))
      const added: FileEntry[] = []
      for (const path of paths) {
        if (have.has(fileKey(path))) continue
        have.add(fileKey(path))
        added.push({ path, memory: true, edited: false, ok: true, failed: 0, blocked: 0, seq: -1000 + added.length })
      }
      const files = list.files.map(file => (keys.has(fileKey(file.path)) ? { ...file, memory: true } : file))
      let skills = list.skills
      always.forEach((name, i) => {
        skills = addSkill(skills, name, -2000 + i, true)
      })
      return { ...list, files: [...files, ...added], skills }
    })
  }

  // Each connector's tool definitions, grouped as its row in the pane is.
  const groups = new Map<string, Weight>()
  const waiting = new Map<string, string>()
  for (const tool of parts.mcpTools ?? []) {
    const connector = connectorOf(tool.name)
    if (!connector) continue
    const key = `c:${connector.key}`
    if (!tool.isLoaded) {
      waiting.set(key, connector.name)
      continue
    }
    const old = groups.get(key)
    groups.set(key, { key, name: connector.named ? connector.name : (old?.name ?? connector.name), tokens: (old?.tokens ?? 0) + tool.tokens })
  }
  const now = await $.clock.now()
  await update($, weightsAtom, () => ({
    model: parts.model ?? '',
    connectors: [...groups.values()],
    skills: (parts.skills?.skillFrontmatter ?? []).map(skill => ({ key: `s:${skill.name}`, name: skill.name, tokens: skill.tokens ?? 0 })),
    files: memory.map(file => ({ key: `f:${fileKey(file.path)}`, name: leaf(file.path), tokens: file.tokens })),
    onDemand: [...waiting].filter(([key]) => !groups.has(key)).map(([, name]) => name),
    at: now,
  }))
}

async function isSkill($: EngineInterface, name: string) {
  if (!skillNames.size) await readContext($).catch(() => undefined)
  return skillNames.has(name)
}

const SLASH = /<command-name>\/?([\w:.-]+)<\/command-name>|^\/([\w:.-]+)/

type Use = SessionMessage['toolUses'][number]

/** Counts what the chat did before the mod loaded. What $.state already counted is left alone. */
async function seed($: EngineInterface) {
  const before = await readInv($)
  const counted = new Set(before.counted)
  const isFirstLoad = !before.connectors.length && !before.files.length && !before.skills.length && !before.sites.length && !before.agents.length
  seq = Math.max(0, ...[...before.connectors, ...before.files, ...before.skills, ...before.sites, ...before.agents].map(row => row.seq))

  const main = await $.session.messages()
  const all: SessionMessage[] = [...main]
  // Only when every subagent's messages came back is an id missing from them gone for good.
  let isWhole = true
  const childTools = new Map<string, number>()
  for (const message of main) {
    for (const use of message.toolUses) {
      if (!use.agentId) continue
      const child = await $.session.messages({ agentId: use.agentId }).catch(() => {
        isWhole = false
        return []
      })
      if (!Array.isArray(child)) continue
      all.push(...child)
      childTools.set(
        use.agentId,
        child.reduce((sum, one) => sum + one.toolUses.length, 0),
      )
    }
  }

  // The list tools' calls replay into the to-do list, unless the list is already tracked.
  const plan = await read($, planAtom)
  if (!plan.updatedAt) {
    let built = plan
    for (const message of main) {
      for (const use of message.toolUses) {
        if (use.agentId || !PLAN_TOOLS.has(use.tool)) continue
        built = planAfter(built, use.tool, use.input, use.result, built.updatedAt + 1) ?? built
      }
    }
    if (built !== plan) await update($, planAtom, now => (now.updatedAt ? now : built))
  }

  const found: { id: string; hit: Hit; seq: number; ending: Ending }[] = []
  const fresh: string[] = []
  const shown = new Set<string>()
  const known = new Set(before.agents.flatMap(row => [row.callId, row.id]).filter(Boolean))
  const agentUses: Use[] = []
  for (const message of all) {
    // A skill typed as a slash command has no call id, so it is only counted on the first load.
    if (isFirstLoad && message.role === 'user') {
      const typed = SLASH.exec(message.text.trim())
      const name = typed?.[1] ?? typed?.[2]
      if (name && (await isSkill($, name))) found.push({ id: '', hit: { kind: 'skill', name }, seq: (seq += 1), ending: {} })
    }
    for (const use of message.toolUses) {
      shown.add(use.tool_use_id)
      if (use.tool === AGENT_TOOL && !known.has(use.tool_use_id) && !(use.agentId && known.has(use.agentId))) {
        known.add(use.tool_use_id)
        agentUses.push(use)
      }
      if (counted.has(use.tool_use_id)) continue
      const hits = hitsOf(use.tool, use.input, use.text ?? '')
      if (!hits.length) continue
      counted.add(use.tool_use_id)
      fresh.push(use.tool_use_id)
      const ending = endingOf(use)
      for (const hit of hits) found.push({ id: use.tool_use_id, hit, seq: (seq += 1), ending })
    }
  }

  // The transcript is read for the call times only when there are new calls to time.
  const times = found.some(one => one.id) || agentUses.length ? await callTimes($) : new Map<string, number>()
  const hits: Stamped[] = found.map(({ id, hit, seq: order, ending }) => ({ hit, seq: order, at: times.get(id) ?? 0, ending }))

  // Subagents that ran before the mod loaded: their time and calls are known, their creds are not.
  const live = agentUses.length ? new Set((await $.agent.list().catch(() => [])).filter(one => one.status === 'running').map(one => one.id)) : new Set<string>()
  const agents = agentUses.map((use): Agent => {
    const result = (use.result && typeof use.result === 'object' ? use.result : {}) as Record<string, unknown>
    const id = use.agentId ?? str(result.agentId)
    const startedAt = times.get(use.tool_use_id) ?? 0
    const ran = use.durationMs ?? (typeof result.totalDurationMs === 'number' ? result.totalDurationMs : undefined)
    const isAnswered = use.result !== undefined || use.text !== undefined
    const ending = endingOf(use)
    return {
      callId: use.tool_use_id,
      id,
      type: str(use.input.subagent_type) || str(result.agentType) || 'general-purpose',
      task: str(use.input.description) || 'Subagent',
      model: str(result.resolvedModel) || str(use.input.model),
      startedAt,
      endedAt: id && live.has(id) ? 0 : ran !== undefined ? startedAt + ran : isAnswered ? Math.max(startedAt, 1) : 0,
      tools: typeof result.totalToolUseCount === 'number' ? result.totalToolUseCount : (childTools.get(id) ?? 0),
      counted: false,
      ...(ending.outcome ? { outcome: ending.outcome } : {}),
      seq: (seq += 1),
    }
  })

  // An id the chat no longer shows was compacted away and can never be counted again, so it is let go;
  // every id still shown is kept, however many there are.
  const keep = (ids: readonly string[]) => (isWhole ? ids.filter(id => shown.has(id)) : [...ids]).slice(-MAX_COUNTED)
  const isStale = isWhole && before.counted.some(id => !shown.has(id))
  if (hits.length || agents.length || isStale) {
    await updateInv($, list => ({ ...apply(list, hits), agents: [...list.agents, ...agents].slice(-MAX_AGENTS), counted: keep([...list.counted, ...fresh]) }))
  }
}

// ---- Live tracking ----

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
}

/** Opens the pane when the chat first has something to show, unless the person closed it. */
async function openOnce($: EngineInterface) {
  if (!autoOpen || (await read($, viewAtom)).closed) return
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === PANE)) return
  await openPane($)
}

type CallInput = Record<string, unknown> & { tool: string; tool_use_id?: string; agentId?: string }

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

/** Ticks once a second while a subagent runs, so its row's timer moves, and stops once none does. */
async function keepTicking($: EngineInterface) {
  const now = await $.clock.now()
  const isRunning = (await readInv($)).agents.some(row => !row.endedAt && row.startedAt > 0 && now - row.startedAt < TICK_AGENTS_MS)
  if (isRunning) {
    ticker ??= $.clock.every(1_000, () => {
      void tick($)
    })
    return
  }
  if (!ticker) return
  ticker.cancel()
  ticker = undefined
  await tick($)
}

async function recordPlan($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown) {
  await ready
  const at = await $.clock.now()
  let changed = false
  await update($, planAtom, now => {
    const after = planAfter(now, tool, input, result, Math.max(at, now.updatedAt + 1))
    if (!after) return now
    changed = true
    return after
  })
  if (changed) await openOnce($)
}

/** One finished call: what it used, how it ended and how long it took. */
async function recordCall($: EngineInterface, call: CallInput, ran: unknown, at: number, ms: number) {
  await ready
  const id = call.tool_use_id ?? ''
  const ending = endingOf(ran)
  if (PLAN_TOOLS.has(call.tool) && !call.agentId && ending.outcome !== 'blocked') await recordPlan($, call.tool, call, (ran as { result?: unknown } | undefined)?.result)
  if (call.tool === AGENT_TOOL) await agentFinished($, call, ran, at, ms, ending)
  const hits = hitsOf(call.tool, call, answerText(ran))
  if (!hits.length && !call.agentId) return
  let isNew = false
  // The check and the count are one write, so a call is never counted twice.
  await updateInv($, list => {
    const isCounted = !!id && list.counted.includes(id)
    if (isCounted) return list
    const stamped = hits.map(hit => ({ hit, seq: (seq += 1), at, ms, ending }))
    isNew = stamped.length > 0
    const after = apply(list, stamped)
    return {
      ...after,
      agents: call.agentId ? after.agents.map(row => (row.id === call.agentId ? { ...row, tools: row.tools + 1 } : row)) : after.agents,
      counted: id ? [...list.counted, id].slice(-MAX_COUNTED) : list.counted,
    }
  })
  if (isNew) await openOnce($)
}

async function recordSkill($: EngineInterface, name: string) {
  await ready
  const at = await $.clock.now()
  await updateInv($, list => apply(list, [{ hit: { kind: 'skill', name }, seq: (seq += 1), at, ending: {} }]))
  await openOnce($)
}

/** An Agent call has started: its row shows at once, before the subagent's id is known. */
async function agentStarted($: EngineInterface, call: CallInput, at: number) {
  await ready
  const callId = call.tool_use_id ?? ''
  if (!callId) return
  const parts = { callId, type: str(call.subagent_type), task: str(call.description), model: str(call.model), startedAt: at }
  await updateInv($, list => ({ ...list, agents: upsertAgent(list.agents, { callId }, () => newAgent(parts), row => row) }))
  await keepTicking($)
  await openOnce($)
}

/** The engine started a subagent: its loop id joins its row, so its requests can be priced. */
async function agentSpawned($: EngineInterface, info: { callId: string; id: string; type: string; task: string; model: string }) {
  await ready
  const at = await $.clock.now()
  await updateInv($, list => ({
    ...list,
    agents: upsertAgent(
      list.agents,
      { callId: info.callId, id: info.id },
      () => newAgent({ ...info, startedAt: at }),
      row => ({ ...row, id: info.id, type: info.type || row.type, model: info.model || row.model, task: row.task !== 'Subagent' ? row.task : info.task || row.task, endedAt: 0 }),
    ),
  }))
  await keepTicking($)
}

/** An Agent call has answered: the subagent is done, or, launched in the background, still running. */
async function agentFinished($: EngineInterface, call: CallInput, ran: unknown, at: number, ms: number, ending: Ending) {
  const callId = call.tool_use_id ?? ''
  const result = ((ran as { result?: unknown } | undefined)?.result ?? {}) as Record<string, unknown>
  const id = str(result.agentId)
  if (!callId && !id) return
  const ranMs = typeof result.totalDurationMs === 'number' ? result.totalDurationMs : undefined
  const isOver = ranMs !== undefined || !!ending.outcome
  await updateInv($, list => ({
    ...list,
    agents: upsertAgent(
      list.agents,
      { callId, id },
      () => newAgent({ callId, id, startedAt: at, type: str(call.subagent_type), task: str(call.description) }),
      row => ({
        ...row,
        id: row.id || id,
        type: row.type !== 'general-purpose' ? row.type : str(result.agentType) || row.type,
        model: str(result.resolvedModel) || row.model,
        tools: typeof result.totalToolUseCount === 'number' ? Math.max(row.tools, result.totalToolUseCount) : row.tools,
        endedAt: isOver ? row.endedAt || (row.startedAt || at) + (ranMs ?? ms) : row.endedAt,
        ...(ending.outcome ? { outcome: ending.outcome } : {}),
      }),
    ),
  }))
  await keepTicking($)
}

/** A subagent's turn began or ended. */
async function agentTurn($: EngineInterface, agentId: string, isStart: boolean) {
  const list = await readInv($)
  if (!list.agents.some(row => row.id === agentId)) return
  const at = await $.clock.now()
  await updateInv($, now => ({ ...now, agents: now.agents.map(row => (row.id === agentId ? { ...row, endedAt: isStart ? 0 : row.endedAt || at } : row)) }))
  await keepTicking($)
}

/**
 * One model request, priced as taskband prices it: a subagent's adds to that subagent; a main-chat
 * request gives each connector, skill and memory file its share. Those sit at the head of every
 * request: read from the cache when it held that much, else written to it again.
 */
async function countRequest($: EngineInterface, agentId: string | undefined, used: Usage) {
  if (agentId) {
    const creds = weigh(used, true)
    await update($, spendAtom, spend => ({ ...spend, byAgent: { ...spend.byAgent, [agentId]: (spend.byAgent[agentId] ?? 0) + creds } }))
    return
  }
  const weights = await read($, weightsAtom)
  const model = used.model || weights.model
  const read_ = used.cache_read_input_tokens || 0
  const prompt = (used.input_tokens || 0) + read_ + (used.cache_creation_input_tokens || 0)
  const items = [...weights.connectors, ...weights.skills, ...weights.files]
  const isCold = read_ < total(items)
  await update($, spendAtom, spend => {
    const carried = { ...spend.carried }
    for (const item of items) carried[item.key] = (carried[item.key] ?? 0) + (isCold ? writeCreds(model, item.tokens, prompt) : readCreds(model, item.tokens, prompt))
    return { ...spend, carried, requests: spend.requests + 1 }
  })
}

// ---- The copied summary ----

const trouble = (failed: number, blocked: number) => [failed ? `${failed} failed` : '', blocked ? `${blocked} blocked` : ''].filter(Boolean).join(', ')
const stampOf = (ms: number) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
const timeOf = (row: Agent) => (!row.endedAt ? 'still running' : row.startedAt && row.endedAt > row.startedAt ? took(row.endedAt - row.startedAt) : 'done')

/** The chat's inventory as Markdown: built here from what the mod recorded, with no request to Claude. */
async function summaryOf($: EngineInterface): Promise<string> {
  const list = await readInv($)
  const plan = await read($, planAtom)
  const weights = await read($, weightsAtom)
  const spend = await read($, spendAtom)
  const stats = await read($, sessionAtom)
  const usage = await $.session.usage().catch(() => undefined)
  const now = await $.clock.now()
  const out = ['# Chat monitor', '', `_${stampOf(now)}_`]
  const section = (title: string, rows: string[]) => {
    if (!rows.length) return
    out.push('', `## ${title}`, '', ...(rows.length > LIST_SHOWN ? [...rows.slice(0, LIST_SHOWN), `- …and ${rows.length - LIST_SHOWN} more`] : rows))
  }
  const plus = (text: string) => (text ? ` (${text})` : '')

  if (stats.at) {
    section(
      'Session',
      sessionRows(stats, usage?.cost?.usd ?? -1, usage?.startedAt ?? 0, now).map(row => `- ${row.label}: ${row.value}${row.note ? `, ${row.note}` : ''}`),
    )
  }

  const done = plan.steps.filter(step => step.status === 'completed').length
  section(
    `To-do, ${done} of ${plan.steps.length} done`,
    plan.steps.map(step => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.text}${step.status === 'in_progress' ? ' _(in progress)_' : ''}`),
  )
  section(
    'Connectors',
    newestFirst(list.connectors).map(row => `- **${labelOf(row)}**: ${count(row.count, 'call')}${plus([row.cli ? (row.mcp ? 'MCP + CLI' : 'CLI') : '', trouble(row.failed, row.blocked)].filter(Boolean).join(', '))}`),
  )
  section('Web', [
    ...newestFirst(list.sites).map(site => `- ${site.host}: ${count(site.count, 'page')}${plus(trouble(site.failed, site.blocked))}`),
    ...[...list.searches].reverse().map(search => `- Search: "${search.detail}"${plus(search.outcome ?? '')}`),
  ])
  const ofAgent = credsOfAgent(spend)
  section(
    'Subagents',
    newestFirst(list.agents).map(row => {
      const creds = ofAgent(row)
      const facts = [row.type, row.model ? modelName(row.model) : '', timeOf(row), count(row.tools, 'tool call'), creds === undefined ? '' : `${row.counted ? '≈' : 'at least '}${amount(creds)} creds`, row.outcome ?? '']
      return `- **${row.task}**: ${facts.filter(Boolean).join(', ')}`
    }),
  )
  const files = newestFirst(list.files)
  section(
    'Files edited',
    files.filter(file => file.edited).map(file => `- \`${tilde(file.path)}\``),
  )
  section(
    'Files read',
    files.filter(file => !file.edited && !file.memory && file.ok).map(file => `- \`${tilde(file.path)}\``),
  )
  section(
    'Files that could not be read or changed',
    files.filter(file => !file.ok).map(file => `- \`${tilde(file.path)}\`${plus(trouble(file.failed, file.blocked))}`),
  )
  section(
    'Skills',
    newestFirst(list.skills).map(skill => {
      const cost = skillCostOf(skill, weights, spend, stats)
      const facts = [skill.always ? 'always loaded' : '', skill.count ? count(skill.count, 'use') : ''].filter(Boolean).join(', ')
      const turns = cost.turns ? `; ${cost.turns === 1 ? 'the turn' : `the ${cost.turns} turns`} it was used in ≈${amount(cost.turnCreds)}` : ''
      const creds = cost.total ? `: ≈${credsText(cost.total)} creds (instructions ≈${credsText(cost.body)}, skill list ≈${credsText(cost.listing)})${turns}` : turns ? `:${turns.slice(1)}` : ''
      return `- /${skill.name}${plus(facts)}${creds}`
    }),
  )
  const rows: string[] = []
  if (weights.at) {
    const costs = costsOf(list, weights, spend)
    rows.push(`- Loaded into every message${costs.model ? ` on ${modelName(costs.model)}` : ''}: ${amount(costs.allTokens)} tokens, ≈${amount(costs.perMessage(costs.allTokens))} a message, ≈${amount(costs.allSoFar)} so far`)
    rows.push(`- Unused: ≈${amount(costs.perMessage(costs.unusedTokens))} a message, ≈${amount(costs.unusedSoFar)} so far`)
    for (const one of costs.connectors.filter(weight => weight.isUnused)) rows.push(`  - ${one.name} (never called): ${amount(one.tokens)} tokens, ≈${amount(costs.perMessage(one.tokens))} a message`)
    if (costs.unusedSkills) rows.push(`  - ${count(costs.unusedSkills, 'unused skill')} in the skill list`)
  }
  section('Creds (1 cred = $0.000004, as taskband counts them)', rows)
  return `${out.join('\n')}\n`
}

/** Puts the summary on the clipboard, or, where there is none, in the chat as a notice Claude never reads. */
async function copySummary($: EngineInterface, surface?: unknown): Promise<string> {
  const text = await summaryOf($)
  const copied = await $.ui.copy({ text, ...(typeof surface === 'string' ? { surface: surface as never } : {}) }).catch(() => undefined)
  if (copied?.isCopied) return 'Copied a summary of this chat.'
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  return 'This app gives no clipboard here, so the summary is in the chat as a notice to copy from.'
}

const toast = ($: EngineInterface, text: string) => {
  try {
    void Promise.resolve($.ui.toast(text)).catch(() => undefined)
  } catch {
    // The toast is only a hint.
  }
}

/** Splits text into lines no wider than `width`, breaking at spaces. */
function wrapLines(text: string, width: number): string[] {
  const room = Math.max(8, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    let rest = word
    while (rest.length > room) {
      if (line) lines.push(line)
      line = ''
      lines.push(rest.slice(0, room))
      rest = rest.slice(room)
    }
    if (!rest) continue
    if (!line) line = rest
    else if (line.length + 1 + rest.length <= room) line += ` ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  if (line || !lines.length) lines.push(line)
  return lines
}

export const register: Register = (on, options) => {
  const settings = (options ?? {}) as Record<string, unknown>
  autoOpen = settings.autoOpen !== 'off'
  setOwnNames(typeof settings.names === 'string' ? settings.names : '')
  setCacheMinutes(Number(settings.cacheMinutes ?? 60))
  const seconds = Number(settings.slowSeconds ?? 30)
  slowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000

  on('session.start', async ($, e, next) => {
    await locate($)
    await $.command.register({ name: 'chat-monitor', description: 'Show session stats, the to-do list, connectors, web, subagents, files, skills and context cost of this chat; /chat-monitor copy copies a summary' })
    ready = seed($)
      .then(() => readContext($))
      .catch(err => log($, 'seed', err))
    // The session stats, from the transcripts; a subagent still running when the mod reloaded keeps its timer.
    void ready
      .then(() => readSession($))
      .then(() => readAgentCosts($))
      .then(() => keepTicking($))
      .catch(err => log($, 'session', err))
    // A chat that already used things shows its pane again after a restart.
    void ready
      .then(async () => {
        const list = await readInv($)
        if (list.connectors.length || list.sites.length || list.agents.length || list.files.some(file => !file.memory) || list.skills.some(skill => skill.count)) await openOnce($)
      })
      .catch(err => log($, 'open', err))
    return next(e)
  })

  // The settings hooks' session start carries the transcript's real path, which the call times are read from.
  on('classic.SessionStart', async ($, e, next) => {
    await notePath($, e).catch(err => log($, 'path', err))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'chat-monitor' }, async ($, e) => {
    if (/^copy\b/i.test(str(e.args))) return { text: await copySummary($) }
    await update($, viewAtom, view => ({ ...view, closed: false }))
    await openPane($)
    void readContext($).catch(err => log($, 'context', err))
    later($, 'session', () => readSession($))
    return { text: 'Opened the In this chat pane.' }
  })

  // A skill the person typed as a slash command.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.command !== 'chat-monitor' && (await isSkill($, e.command))) await recordSkill($, e.command)
    } catch (err) {
      await log($, 'command', err)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Every tool call, in the main chat and in subagents. The call runs at once; what it used, how it
  // ended and how long it took are recorded after its result has gone back to Claude.
  on('tool.call', async ($, e, next) => {
    const call = e as unknown as CallInput
    const begun = $.clock.now()
    if (call.tool === AGENT_TOOL) later($, 'agent', async () => agentStarted($, call, await begun))
    const ran = await next(e)
    const ended = $.clock.now()
    later($, 'tool.call', async () => {
      const at = await begun
      await recordCall($, call, ran, at, (await ended) - at)
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A subagent the engine starts: its id joins the row of the Agent call that asked for it.
  on('agent.spawn', async ($, e, next) => {
    const got = await next(e)
    if (got.agentId) {
      const callId = e.workflow ? `wf:${e.workflow.runId}:${e.workflow.agentIndex}` : e.tool_use_id || `spawn:${got.agentId}`
      const info = { callId, id: got.agentId, type: e.subagentType, task: e.description, model: got.model ?? '' }
      later($, 'spawn', () => agentSpawned($, info))
    }
    return got
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) later($, 'turn', () => agentTurn($, agentId, true))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    // A main turn's end: what the context holds may have moved (a tool searched for, a skill loaded).
    later($, 'turn', () => (agentId ? agentTurn($, agentId, false) : readContext($)))
    // Each subagent's cost by Claude Code's own estimate, as it stands now.
    later($, 'agents', () => readAgentCosts($))
    // Any turn's end moves the session stats. The transcript may still be taking the turn's last
    // lines, so they are read again a moment later; an unchanged transcript is not read twice.
    later($, 'session', () => readSession($))
    try {
      $.clock.after(3_000, () => later($, 'session', () => readSession($)))
    } catch (err) {
      void log($, 'session', err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every model request, the main chat's and each subagent's, priced once its answer is in.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      const used = response?.usage
      if (used) later($, 'step', () => countRequest($, e.agentId, used))
    } catch {
      // The pane misses one request; the request itself is untouched.
    }
    return response
  })

  // The person's own close keeps the pane closed until they ask for it again.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, viewAtom, view => ({ ...view, closed: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Presses: a card's title folds it, a row opens its calls, the file list grows or shrinks.
  on('ui.press', async ($, e, next) => {
    const key = e.element
    // A card's label and its arrow both fold it.
    if (key.startsWith('sec-') || key.startsWith('fold-')) {
      const id = key.slice(key.indexOf('-') + 1)
      await update($, viewAtom, view => ({ ...view, folded: view.folded.includes(id) ? view.folded.filter(one => one !== id) : [...view.folded, id] }))
    } else if (/^[cws]:/.test(key) || key === 'searches' || key === 'skills-list') {
      await update($, viewAtom, view => ({ ...view, open: view.open === key ? '' : key }))
    } else if (key === 'hide') {
      await update($, viewAtom, view => ({ ...view, closed: true }))
      await $.ui.close({ id: PANE }).catch(() => undefined)
      toast($, 'Hidden. Type /chat-monitor to show it again.')
    } else if (key === 'copy') {
      toast($, await copySummary($, e.surface))
    } else if (key === 'files-all') {
      await update($, viewAtom, view => ({ ...view, allFiles: !view.allFiles }))
    } else {
      return next(e)
    }
    return { element: e.element }
  })

  // The pane is a stack of cards, one per section: an icon and a title that folds the card,
  // its figure on the right, and the rows beneath.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Pictures (logos, icons, check marks) draw everywhere but the terminal, which gets text marks.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const width = Math.max(28, e.props.bodyColumns)
    // A card's content: its width less the border, two cells of padding on the left and one on the
    // right, so the content sits in from the left as far as it does from the right.
    const PAD_LEFT = 2
    const PAD_RIGHT = 1
    const inner = width - 2 - PAD_LEFT - PAD_RIGHT
    const list = await readInv($)
    const plan = await read($, planAtom)
    const view = await read($, viewAtom)
    const weights = await read($, weightsAtom)
    const spend = await read($, spendAtom)
    const stats = await read($, sessionAtom)
    // Read so each tick redraws the running subagents' timers.
    await read($, nowAtom)
    const now = await $.clock.now()
    const usage = await $.session.usage().catch(() => undefined)
    const nothing = () => undefined

    const connectors = newestFirst(list.connectors)
    const sites = newestFirst(list.sites)
    const files = newestFirst(list.files)
    const skills = newestFirst(list.skills)
    const agents = [...list.agents].sort((a, b) => Number(!b.endedAt) - Number(!a.endedAt) || b.seq - a.seq)
    const runningAgents = agents.filter(row => !row.endedAt).length
    const done = plan.steps.filter(step => step.status === 'completed').length
    const statRows = sessionRows(stats, usage?.cost?.usd ?? -1, usage?.startedAt ?? 0, now)

    // Minimized on the desktop: one glance, no buttons.
    if (e.props.placement === 'widget') {
      const facts = [
        stats.at ? statRows[0]!.value.split(' · ')[0]! : '',
        runningAgents ? `${runningAgents} running` : '',
        plan.steps.length ? `${done}/${plan.steps.length} steps` : '',
        connectors.length ? count(connectors.length, 'connector') : '',
        sites.length ? count(sites.length, 'site') : '',
        agents.length ? count(agents.length, 'subagent') : '',
        files.length ? count(files.length, 'file') : '',
        skills.length ? count(skills.length, 'skill') : '',
      ].filter(Boolean)
      return (
        <Box flexDirection="column">
          <Text weight="semibold">{TITLE}</Text>
          <Text dimColor>{facts.join(' · ') || 'Nothing used yet'}</Text>
        </Box>
      )
    }

    // One line: what is on the left may be cut short, what is on the right never is.
    const line = (key: string, left: unknown, right: unknown, room = inner) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center" width={room} height={1} columnGap={1}>
        <Box flexDirection="row" alignItems="center" flexShrink={1} flexGrow={1} minWidth={0} height={1} overflow="hidden" columnGap={1}>
          {left as never}
        </Box>
        {right ? <Box flexShrink={0}>{right as never}</Box> : null}
      </Box>
    )
    const quiet = (text: string) => wrapLines(text, inner).map((part, i) => <Text key={`q${i}`} dimColor>{part}</Text>)
    const more = (hidden: number, key: string) =>
      hidden > 0 ? (
        <Text key={key} dimColor mono size="caption">
          {`+${hidden} more`}
        </Text>
      ) : null
    const toneOf = (outcome?: Outcome) => (outcome === 'failed' ? { color: BAD } : outcome === 'blocked' ? { color: WARN } : {})
    const markOf = (outcome?: Outcome) => (outcome === 'failed' ? '✕ ' : outcome === 'blocked' ? '⊘ ' : '')
    const troubles = (failed: number, blocked: number) => [
      failed ? <Text key="tf" color={BAD}>{` · ${failed} failed`}</Text> : null,
      blocked ? <Text key="tb" color={WARN}>{` · ${blocked} blocked`}</Text> : null,
    ]

    // ---- The pieces every card is made of ----

    // The pictures, the tints and the hover lift are the surfaces that draw pictures; the terminal
    // draws the same layout in its own colours.
    const isRich = !!Svg
    const Select = ('Select' in table ? (table as { Select?: unknown }).Select : undefined) as undefined | ((props: Record<string, unknown>) => unknown)
    /** A small lowercase monospace label, over a section or a figure. */
    const eyebrow = (key: string, text: string) => (
      <Text key={key} mono size="caption" dimColor>
        {text}
      </Text>
    )
    /**
     * A chip: a tag in a tone's own faint colour, or a quiet grey one. The label is its own Text, so it
     * reads alone. It keeps its whole width and never wraps: whatever stands beside it gives way.
     */
    const chip = (key: string, label: string, tone?: { color: string; hex: string }) => (
      <Box key={key} flexShrink={0}>
        {isRich ? (
          <Text size="caption" wrap="truncate" backgroundColor={tone ? tint(tone.hex) : CHIP} {...(tone ? { color: tone.color } : { dimColor: true })}>
            {' '}
            <Text>{label}</Text>{' '}
          </Text>
        ) : (
          <Text wrap="truncate" {...(tone ? { color: tone.color } : { dimColor: true })}>
            <Text>{label}</Text>
          </Text>
        )}
      </Box>
    )
    /** A name that gives way to what stands beside it, cut short with an ellipsis. */
    const giving = (key: string, child: unknown) => (
      <Box key={key} flexShrink={1} minWidth={0} overflow="hidden">
        {child as never}
      </Box>
    )
    const TONES = { accent: { color: ACCENT, hex: HUE.accent }, good: { color: GOOD, hex: HUE.good }, warn: { color: WARN, hex: HUE.warn }, bad: { color: BAD, hex: HUE.bad } }
    /** A tile picture, or on the terminal its first letter in a coloured block. */
    const tileOr = (source: string, alt: string, letter: string, hex: string) =>
      Svg ? (
        <Svg source={source} alt={alt} width={28} height={28} />
      ) : (
        <Text backgroundColor={hex} color="#ffffff" weight="bold">
          {` ${letter.toUpperCase()} `}
        </Text>
      )
    /**
     * One row of a list: a tile, a name over a monospace caption, and the figure on the right, with
     * an arrow when it opens. The row lifts under the pointer.
     */
    const row = (key: string, parts: { tile?: unknown; head: unknown; caption?: unknown; right?: unknown; isOpen?: boolean }) => (
      <Box key={key} flexDirection="row" alignItems="center" width={inner} columnGap={1} {...(isRich ? { hover: { backgroundColor: FILL } } : {})}>
        {parts.tile ? <Box flexShrink={0}>{parts.tile as never}</Box> : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {parts.head as never}
          {(parts.caption ?? null) as never}
        </Box>
        {parts.right || parts.isOpen !== undefined ? (
          <Box flexShrink={0} flexDirection="row" alignItems="center" columnGap={1}>
            {(parts.right ?? null) as never}
            {parts.isOpen === undefined ? null : <Text dimColor>{parts.isOpen ? '▾' : '▸'}</Text>}
          </Box>
        ) : null}
      </Box>
    )
    /** The same, for where `row` names something else. */
    const listRow = row
    /** A row's monospace caption. */
    const caption = (key: string, text: string, extra: unknown = null) => (
      <Text key={key} dimColor mono size="caption" wrap="truncate-end">
        {text}
        {extra as never}
      </Text>
    )
    /** A figure on the right: the number in the accent, its unit quiet. */
    const figureOf = (value: string, unit: string) => (
      <Text tabular>
        <Text color={ACCENT} weight="semibold">
          {value}
        </Text>
        <Text dimColor>{unit}</Text>
      </Text>
    )
    /** What a row opens onto: an inset, a step in from the left, on a faint fill. */
    const INSET = 3
    const insetRoom = inner - INSET - 2 - (isRich ? 2 : 0)
    const inset = (key: string, children: unknown) => (
      <Box key={key} flexDirection="column" width={inner - INSET} marginLeft={INSET} paddingX={1} {...(isRich ? { backgroundColor: FILL, borderStyle: 'round', borderColor: FILL } : {})}>
        {children as never}
      </Box>
    )
    /** A section with nothing in it yet: a dashed placeholder saying what will show there. */
    const empty = (key: string, text: string) =>
      isRich ? (
        <Box key={key} borderStyle="dashed" borderColor={LINE} paddingX={1} width={inner}>
          <Text dimColor wrap="wrap">
            {text}
          </Text>
        </Box>
      ) : (
        quiet(text)
      )
    /** A sort for a list: a dropdown where the surface has one. */
    const sortOf = (id: string) => view.sort?.[id] ?? 'newest'
    const sorter = (id: string, options: readonly string[]) =>
      Select ? (
        <Select
          key={`sort-${id}`}
          options={options.map(value => ({ value, label: value }))}
          value={sortOf(id)}
          onSelect={(value: string) => update($, viewAtom, old => ({ ...old, sort: { ...(old.sort ?? {}), [id]: value } }))}
        />
      ) : null

    /**
     * A card: a hairline round its section, a monospace label that folds it, its figure in a chip,
     * a sort where its list has one, and an arrow that folds it too.
     */
    const card = (id: string, title: string, figure: string, body: unknown, extra: unknown = null) => {
      const isOpen = !view.folded.includes(id)
      return (
        <Box key={id} flexDirection="column" borderStyle="round" {...(isRich ? { borderColor: LINE } : { borderDimColor: true })} paddingLeft={PAD_LEFT} paddingRight={PAD_RIGHT} width={width} flexShrink={0}>
          <Box flexDirection="row" alignItems="center" width={inner} columnGap={1}>
            {isRich ? null : <Text dimColor>{isOpen ? '▾' : '▸'}</Text>}
            <Button key={`sec-${id}`} plain onPress={nothing}>
              <Text mono size="caption" dimColor>
                {title}
              </Text>
            </Button>
            {figure ? chip(`fig-${id}`, figure) : null}
            <Box flexGrow={1} />
            {isOpen ? (extra as never) : null}
            {isRich ? <Button key={`fold-${id}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={nothing} /> : null}
          </Box>
          {isOpen ? (
            <Box flexDirection="column" width={inner}>
              {body as never}
            </Box>
          ) : null}
        </Box>
      )
    }

    // One call under its row: what it was, when, how long, and how it ended.
    const callRow = (key: string, call: Call, room: number, show: (detail: string) => string) => {
      const isSlow = call.ms !== undefined && call.ms >= slowMs
      const right = [call.cli ? 'CLI' : '', clockTime(call.at), call.ms !== undefined ? took(call.ms) : ''].filter(Boolean).join(' · ')
      return (
        <Box key={key} flexDirection="column" width={room}>
          {line(
            `${key}-row`,
            [
              <Text key="t" wrap="truncate-end" {...toneOf(call.outcome)}>
                {`${markOf(call.outcome)}${call.tool}`}
                {call.detail ? <Text dimColor>{`  ${show(call.detail)}`}</Text> : null}
              </Text>,
            ],
            <Text tabular {...(isSlow ? { color: WARN } : { dimColor: true })}>
              {`${right}${isSlow ? ' slow' : ''}` || ' '}
            </Text>,
            room,
          )}
          {call.error ? (
            <Text dimColor wrap="truncate-end">
              {`  ${call.error}`}
            </Text>
          ) : null}
        </Box>
      )
    }
    const callList = (key: string, calls: readonly Call[], all: number, show: (detail: string) => string = detail => detail) => {
      const shown = [...calls].reverse().slice(0, CALLS_SHOWN)
      return inset(`calls-${key}`, [...shown.map((call, i) => callRow(`call-${key}-${i}`, call, insetRoom, show)), more(all - shown.length, `more-${key}`)])
    }

    // Session, the summary card: the total large, with where it came from; the time and the work in
    // monospace; a bar of what the creds paid for, with its legend; and four tiles of what stands out.
    const ledgerUsd = usage?.cost?.usd ?? -1
    const kinds = stats.creds
    const estimate = kinds.read + kinds.write + kinds.fresh + kinds.output
    const whole = ledgerUsd >= 0 ? ledgerUsd / DOLLARS_PER_CRED : estimate
    const startedAt = usage?.startedAt ?? 0
    const half = Math.floor((inner - 1) / 2)
    const tile = (key: string, label: string, value: string, note = '') => (
      <Box key={key} flexDirection="column" width={half} paddingX={1} {...(isRich ? { backgroundColor: FILL, borderStyle: 'round', borderColor: FILL } : {})}>
        {eyebrow(`${key}-l`, label)}
        <Text key={`${key}-v`} size="heading" weight="semibold" tabular wrap="truncate-end">
          {value}
        </Text>
        {note ? caption(`${key}-n`, note) : null}
      </Box>
    )
    const SPLIT = [
      { key: 'reading', share: kinds.read, hex: HUE.blue },
      { key: 'writing', share: kinds.write, hex: HUE.accent },
      { key: 'output', share: kinds.output, hex: HUE.violet },
      { key: 'new input', share: kinds.fresh, hex: HUE.grey },
    ]
    const shareOf = (n: number) => Math.round((100 * n) / (estimate || 1))
    const sessionBody = stats.at
      ? [
          line(
            'sum-top',
            [eyebrow('l', 'session')],
            chip('src', ledgerUsd >= 0 ? 'total from Claude Code' : 'by the price table', ledgerUsd >= 0 ? TONES.good : undefined),
          ),
          <Box key="sum-figure" flexDirection="row" alignItems="flex-end" width={inner} columnGap={1}>
            <Text key="v" size="title" weight="semibold" tabular>
              {`≈${amount(whole)}`}
            </Text>
            <Text key="u" dimColor>
              creds
            </Text>
            <Box flexGrow={1} />
            <Text key="usd" tabular dimColor>{`$${(whole * DOLLARS_PER_CRED).toFixed(2)}`}</Text>
          </Box>,
          caption('sum-time', `${startedAt > 0 && now > startedAt ? `open ${span(now - startedAt)} · ` : ''}working ${span(stats.workingMs)}`),
          stats.requests ? caption('sum-work', [count(stats.prompts, 'prompt'), count(stats.requests, 'request'), count(stats.tools, 'tool call')].join(' · ')) : null,
          estimate && Svg ? (
            <Box key="sum-split" width={inner} marginTop={1}>
              <Svg source={splitBar(SPLIT)} alt={SPLIT.map(one => `${one.key} ${shareOf(one.share)}%`).join(', ')} height={8} />
            </Box>
          ) : null,
          estimate ? (
            <Text key="sum-legend" size="caption" dimColor wrap="wrap">
              {SPLIT.filter(one => one.key !== 'new input' || shareOf(one.share) >= 1).map((one, i) => (
                <Text key={one.key}>
                  {i ? '   ' : ''}
                  <Text color={one.hex}>●</Text>
                  {` ${one.key} ${shareOf(one.share)}%`}
                </Text>
              ))}
            </Text>
          ) : null,
          stats.requests ? (
            <Box key="sum-tiles-1" flexDirection="row" width={inner} columnGap={1} marginTop={1}>
              {tile('hits', 'cache hits', `${Math.round((100 * stats.tokens.read) / (stats.tokens.read + stats.tokens.write + stats.tokens.fresh || 1))}%`)}
              {tile('cold', 'cold sends', String(stats.cold.count), stats.cold.count ? `≈${amount(stats.cold.creds)} creds` : 'none')}
            </Box>
          ) : null,
          stats.requests ? (
            // The same small gap between the two rows of tiles as between the tiles side by side.
            <Box key="sum-tiles-2" flexDirection="row" width={inner} columnGap={1} marginTop="sm">
              {tile('priciest', 'priciest prompt', stats.priciest.creds ? `≈${amount(stats.priciest.creds)}` : '—', stats.priciest.creds ? `“${stats.priciest.text}”` : '')}
              {tile('average', 'per prompt', stats.prompts ? `≈${amount(stats.promptCreds / stats.prompts)}` : '—', 'average')}
            </Box>
          ) : null,
        ]
      : quiet('Reading this chat…')

    // To-do: the list's title, then each step with its mark. Done steps are struck through.
    const stepRoom = inner - 3
    const stepRow = (step: Step, i: number) => {
      const isDone = step.status === 'completed'
      const isRunning = step.status === 'in_progress'
      return (
        <Box key={`step${i}`} flexDirection="row" width={inner} flexShrink={0} columnGap={1}>
          <Box flexShrink={0}>
            {Svg ? (
              <Svg source={MARKS[step.status]} alt={isDone ? 'done' : isRunning ? 'running' : 'waiting'} width={16} height={16} />
            ) : isDone ? (
              <Text color={GOOD}>✓</Text>
            ) : isRunning ? (
              <Text color={ACCENT}>●</Text>
            ) : (
              <Text dimColor>○</Text>
            )}
          </Box>
          <Box flexDirection="column" width={stepRoom} flexShrink={1}>
            {wrapLines(isRunning && step.active ? step.active : step.text, stepRoom).map((part, j) => (
              <Text key={`l${j}`} dimColor={isDone} strikethrough={isDone} weight={isRunning ? 'semibold' : 'regular'}>
                {part}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }
    // On the surfaces that draw pictures a thin line joins each step's mark to the next: a stepper.
    const stepJoin = (i: number) =>
      Svg ? (
        <Box key={`join${i}`} flexShrink={0}>
          <Svg source={STEP_LINE} alt="then" width={16} height={8} />
        </Box>
      ) : null
    const todoBody = plan.steps.length
      ? [
          ...(plan.title
            ? wrapLines(plan.title, inner).map((part, i) => (
                <Text key={`title${i}`} weight="semibold">
                  {part}
                </Text>
              ))
            : []),
          ...plan.steps.flatMap((step, i) => (i ? [stepJoin(i), stepRow(step, i)] : [stepRow(step, i)])),
        ]
      : empty('todo-empty', 'No to-do list yet. Claude makes one for work with several steps.')

    // Connectors: the logo, the name over its latest tool and any trouble, and the call count. Press a
    // name for its calls, in an inset under it. Sorted newest first, by calls, or by name.
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
    const sortedConnectors =
      sortOf('connectors') === 'most calls' ? [...connectors].sort((a, b) => b.count - a.count) : sortOf('connectors') === 'a to z' ? [...connectors].sort((a, b) => byName(labelOf(a), labelOf(b))) : connectors
    const connectorBody = connectors.length
      ? [
          ...sortedConnectors.slice(0, ROWS_SHOWN).map(one => {
            const label = labelOf(one)
            const key = `c:${one.key}`
            const isOpen = view.open === key
            const latest = one.calls[one.calls.length - 1]
            const via = one.cli && !one.mcp ? ' · CLI' : one.cli ? ' · MCP + CLI' : ''
            return (
              <Box key={`conn-${one.key}`} flexDirection="column" width={inner}>
                {row(`conn-r-${one.key}`, {
                  tile: tileOr(tileOf(slug(label), label), label, label[0] ?? '?', hueOf(slug(label))),
                  head: (
                    <Button key={key} plain onPress={nothing}>
                      <Text weight={isOpen ? 'semibold' : 'medium'}>{label}</Text>
                    </Button>
                  ),
                  caption: caption('c', `${(latest?.tool ?? 'run').replace(/\s+/g, '_')}${via}`, troubles(one.failed, one.blocked)),
                  right: figureOf(String(one.count), one.count === 1 ? ' call' : ' calls'),
                  isOpen,
                })}
                {isOpen ? callList(one.key, one.calls, one.count) : null}
              </Box>
            )
          }),
          more(connectors.length - ROWS_SHOWN, 'more-connectors'),
        ]
      : empty('conn-empty', 'None used yet. Connectors and command-line tools Claude calls show here.')

    // Web: each site with its pages, then the searches. Press a site or Searches for the list.
    const searchTrouble = (outcome: Outcome) => list.searches.filter(one => one.outcome === outcome).length
    const sortedSites = sortOf('web') === 'most pages' ? [...sites].sort((a, b) => b.count - a.count) : sortOf('web') === 'a to z' ? [...sites].sort((a, b) => byName(a.host, b.host)) : sites
    const lastSearch = list.searches[list.searches.length - 1]
    const webBody =
      sites.length || list.searches.length
        ? [
            ...sortedSites.slice(0, ROWS_SHOWN).map(site => {
              const key = `w:${site.host}`
              const isOpen = view.open === key
              const latest = site.calls[site.calls.length - 1]
              return (
                <Box key={`site-${site.host}`} flexDirection="column" width={inner}>
                  {row(`site-r-${site.host}`, {
                    tile: tileOr(glyphTile(site.host[0] ?? '?', hueOf(site.host)), site.host, site.host[0] ?? '?', hueOf(site.host)),
                    head: (
                      <Button key={key} plain onPress={nothing}>
                        <Text weight={isOpen ? 'semibold' : 'medium'}>{site.host}</Text>
                      </Button>
                    ),
                    caption: latest ? caption('c', `${latest.tool} · ${pathOf(latest.detail)}`) : null,
                    right: (
                      <Text tabular>
                        {count(site.count, 'page')}
                        {troubles(site.failed, site.blocked)}
                      </Text>
                    ),
                    isOpen,
                  })}
                  {isOpen ? callList(site.host, site.calls, site.count, pathOf) : null}
                </Box>
              )
            }),
            more(sites.length - ROWS_SHOWN, 'more-sites'),
            list.searches.length ? (
              <Box key="searches-box" flexDirection="column" width={inner}>
                {row('searches-r', {
                  tile: tileOr(SEARCH_TILE, 'Searches', '?', HUE.blue),
                  head: (
                    <Button key="searches" plain onPress={nothing}>
                      <Text weight={view.open === 'searches' ? 'semibold' : 'medium'}>Searches</Text>
                    </Button>
                  ),
                  caption: lastSearch ? caption('c', `“${lastSearch.detail}”`) : null,
                  right: (
                    <Text tabular>
                      {String(list.searches.length)}
                      {troubles(searchTrouble('failed'), searchTrouble('blocked'))}
                    </Text>
                  ),
                  isOpen: view.open === 'searches',
                })}
                {view.open === 'searches' ? callList('searches', list.searches, list.searches.length) : null}
              </Box>
            ) : null,
          ]
        : empty('web-empty', 'No pages fetched or searches yet.')

    // Subagents: each one's task over its type, model, tool calls and time, with its creds on the right.
    const ofAgent = credsOfAgent(spend)
    const agentRow = (row: Agent) => {
      const isRunning = !row.endedAt
      const creds = ofAgent(row)
      const time = isRunning ? (row.startedAt ? `running ${elapsed(now - row.startedAt)}` : 'running') : row.startedAt && row.endedAt > row.startedAt ? took(row.endedAt - row.startedAt) : 'done'
      const facts = [row.type, row.model ? modelName(row.model) : '', count(row.tools, 'tool'), time].filter(Boolean).join(' · ')
      // Its tile says how it stands: a spinner while it runs, then a check, a cross or a bar.
      const state = isRunning ? 'running' : row.outcome === 'failed' ? 'failed' : row.outcome === 'blocked' ? 'blocked' : 'done'
      const letter = { running: '•', done: '✓', failed: '✕', blocked: '⊘' }[state]
      const hex = { running: HUE.accent, done: HUE.good, failed: HUE.bad, blocked: HUE.warn }[state]
      return listRow(`agent-${row.callId}`, {
        tile: tileOr(AGENT_TILES[state], state, letter, hex),
        head: (
          <Text key="t" wrap="truncate-end" weight={isRunning ? 'semibold' : 'medium'} {...toneOf(row.outcome)}>
            {`${markOf(row.outcome)}${row.task}`}
          </Text>
        ),
        caption: (
          <Text key="f" dimColor mono size="caption" wrap="truncate-end">
            {facts}
          </Text>
        ),
        right: creds === undefined ? <Text dimColor>—</Text> : figureOf(`${row.counted ? '≈' : '≥'}${amount(creds)}`, ' creds'),
      })
    }
    const agentBody = agents.length
      ? [
          ...agents.slice(0, ROWS_SHOWN).map(agentRow),
          more(agents.length - ROWS_SHOWN, 'more-agents'),
        ]
      : empty('agents-empty', 'None started yet. Subagents show here with their time and creds.')

    // Context files: how many were read, then the newest few with their folder.
    const memoryTokens = new Map(weights.files.map(one => [one.key, one.tokens]))
    const fileRow = (file: FileEntry) => {
      const cut = file.path.lastIndexOf('/')
      const folder = tilde(cut > 0 ? file.path.slice(0, cut) : '/')
      const parts = folder.split('/').filter(Boolean)
      // One line per file: a long folder shows only its last part.
      const short = folder.length > 26 && parts.length > 1 ? `…/${parts[parts.length - 1]}` : folder
      const tokens = memoryTokens.get(`f:${fileKey(file.path)}`)
      // A tag for how it was used: edited, blocked, failed, loaded at the start, or read.
      const tag = file.edited
        ? chip('tag', 'edited', TONES.accent)
        : !file.ok && file.blocked
          ? chip('tag', 'blocked', TONES.warn)
          : !file.ok
            ? chip('tag', 'failed', TONES.bad)
            : file.memory
              ? chip('tag', tokens ? `auto · ${amount(tokens)} tok` : 'auto')
              : chip('tag', 'read')
      return row(`file-${file.path}`, {
        head: (
          <Text key="n" weight="medium" wrap="truncate-end">
            {file.path.slice(cut + 1)}
          </Text>
        ),
        caption: caption('f', short),
        right: tag,
      })
    }
    // Sorted newest first, edited first, or by name.
    const sortedFiles =
      sortOf('files') === 'edited first'
        ? [...files].sort((a, b) => Number(b.edited) - Number(a.edited) || b.seq - a.seq)
        : sortOf('files') === 'a to z'
          ? [...files].sort((a, b) => byName(leaf(a.path), leaf(b.path)))
          : files
    const shownFiles = view.allFiles ? sortedFiles : sortedFiles.slice(0, FILES_SHOWN)
    const fileBody = files.length
      ? [
          ...shownFiles.map(fileRow),
          files.length > FILES_SHOWN ? (
            <Box key="files-toggle" flexDirection="row" width={inner} justifyContent="center" marginTop={1}>
              <Button key="files-all" variant="secondary" label={view.allFiles ? 'Show fewer' : `Show all ${files.length}`} onPress={nothing} />
            </Box>
          ) : null,
        ]
      : empty('files-empty', 'None read or changed yet. Files Claude reads or edits show here.')

    // Skills: each one's name over its uses and size, with its creds on the right. Press a name for
    // what they paid for: its instructions, its line in the skill list, and the turns it was used in.
    const skillCosts = new Map(skills.map(skill => [skill.name, skillCostOf(skill, weights, spend, stats)]))
    const skillsTotal = [...skillCosts.values()].reduce((sum, cost) => sum + cost.total, 0)
    /** A label and its figure on one line, or the figure on the line below where both do not fit. */
    const detailLine = (key: string, label: string, value: string, room: number) =>
      label.length + value.length + 2 <= room ? (
        line(key, [<Text key="l">{label}</Text>], <Text dimColor tabular>{value}</Text>, room)
      ) : (
        <Box key={key} flexDirection="column" width={room}>
          <Text key="l">{label}</Text>
          <Text key="v" dimColor tabular wrap="truncate-end">
            {`  ${value}`}
          </Text>
        </Box>
      )
    const skillDetail = (name: string, cost: SkillCost) => {
      const room = insetRoom
      const loads = cost.loads > 1 ? ` · ${cost.loads} loads` : ''
      return inset(`skill-d-${name}`, [
        detailLine(`sd-body-${name}`, 'Instructions', cost.tokens ? `${amount(cost.tokens)} tok${loads} · ${count(cost.requests, 'request')} · ≈${credsText(cost.body)}` : 'not loaded here', room),
        detailLine(`sd-list-${name}`, 'Skill list line', cost.listingTokens ? `${amount(cost.listingTokens)} tok · ≈${credsText(cost.listing)}` : 'not listed', room),
        cost.turns ? detailLine(`sd-turns-${name}`, 'Used in', `${count(cost.turns, 'turn')} · ≈${amount(cost.turnCreds)}`, room) : null,
        ...(cost.turns
          ? wrapLines('A turn counts all its work, not only the skill’s.', room).map((part, i) => (
              <Text key={`sd-note-${i}`} dimColor size="caption">
                {part}
              </Text>
            ))
          : []),
      ])
    }
    const skillRow = (skill: Skill) => {
      const key = `s:${skill.name}`
      const isOpen = view.open === key
      const cost = skillCosts.get(skill.name)!
      const facts = [skill.always ? 'always loaded' : '', skill.count ? count(skill.count, 'use') : '', cost.tokens ? `${amount(cost.tokens)} tok` : ''].filter(Boolean).join(' · ')
      return (
        <Box key={`skill-${skill.name}`} flexDirection="column" width={inner}>
          {row(`skill-r-${skill.name}`, {
            tile: tileOr(glyphTile('/', HUE.accent), 'skill', '/', HUE.accent),
            head: (
              <Button key={key} plain onPress={nothing}>
                <Text weight={isOpen ? 'semibold' : 'medium'} wrap="truncate-end">
                  {skill.name}
                </Text>
              </Button>
            ),
            caption: facts ? caption('f', facts) : null,
            right: cost.total ? figureOf(`≈${credsText(cost.total)}`, ' creds') : <Text dimColor>—</Text>,
            isOpen,
          })}
          {isOpen ? skillDetail(skill.name, cost) : null}
        </Box>
      )
    }
    // Sorted newest first, by creds, or by name.
    const sortedSkills =
      sortOf('skills') === 'most creds'
        ? [...skills].sort((a, b) => (skillCosts.get(b.name)?.total ?? 0) - (skillCosts.get(a.name)?.total ?? 0))
        : sortOf('skills') === 'a to z'
          ? [...skills].sort((a, b) => byName(a.name, b.name))
          : skills
    const skillBody = skills.length
      ? [
          ...sortedSkills.slice(0, ROWS_SHOWN).map(skillRow),
          more(skills.length - ROWS_SHOWN, 'more-skills'),
        ]
      : empty('skills-empty', 'None used yet. Skills Claude loads show here with what they cost.')

    // Context cost: what is loaded into every message, in creds a message and so far, unused first.
    const costs = costsOf(list, weights, spend)
    const unusedTone = costs.unusedTokens ? { color: WARN } : { dimColor: true }
    // Each item: its name and any tag over a thin bar of its share, the largest full, amber when unused.
    // A small gap parts the name from its bar, and a larger one each item from the one above it.
    const largest = Math.max(1, ...costs.connectors.map(one => one.tokens), total(costs.skills), total(weights.files))
    const costLine = (key: string, name: unknown, tokens: number, isUnused = false) => (
      <Box key={key} flexDirection="column" width={inner} rowGap="xs" marginTop="sm">
        {line(
          `${key}-l`,
          name,
          <Text dimColor tabular>
            {`${amount(tokens)} tok · ≈${amount(costs.perMessage(tokens))}`}
          </Text>,
        )}
        {Svg ? (
          <Box key={`${key}-b`} width={inner}>
            <Svg source={thinBar(tokens / largest, isUnused ? HUE.warn : HUE.grey)} alt={`${amount(tokens)} tokens`} height={4} />
          </Box>
        ) : null}
      </Box>
    )
    const costBody = weights.at
      ? [
          <Text key="cap" dimColor wrap="truncate-end">
            {`Loaded into every message${costs.model ? ` on ${modelName(costs.model)}` : ''}, in creds`}
          </Text>,
          line(
            'cost-all',
            [<Text key="l">Every message</Text>],
            <Text tabular>{`≈${amount(costs.perMessage(costs.allTokens))} · ≈${amount(costs.allSoFar)} so far`}</Text>,
          ),
          line(
            'cost-unused',
            [
              <Text key="l" {...unusedTone}>
                Unused
              </Text>,
            ],
            <Text tabular {...unusedTone}>
              {`≈${amount(costs.perMessage(costs.unusedTokens))} · ≈${amount(costs.unusedSoFar)} so far`}
            </Text>,
          ),
          ...costs.connectors.slice(0, ROWS_SHOWN).map(one =>
            costLine(
              `cost-${one.key}`,
              [
                giving(
                  'n',
                  <Text weight="medium" wrap="truncate-end">
                    {one.name}
                  </Text>,
                ),
                one.isUnused ? chip('u', 'unused', TONES.warn) : null,
              ],
              one.tokens,
              one.isUnused,
            ),
          ),
          costs.skills.length ? (
            <Box key="cost-skills-box" flexDirection="column" width={inner}>
              {costLine(
                'cost-skills',
                [
                  <Button key="skills-list" plain onPress={nothing}>
                    <Text weight={view.open === 'skills-list' ? 'semibold' : 'medium'}>{`Skill list · ${costs.skills.length}`}</Text>
                  </Button>,
                  costs.unusedSkills ? chip('u', `${costs.unusedSkills} unused`, TONES.warn) : null,
                  <Text key="a" dimColor>
                    {view.open === 'skills-list' ? '▾' : '▸'}
                  </Text>,
                ],
                total(costs.skills),
              )}
              {view.open === 'skills-list'
                ? inset('cost-skill-rows', [
                    ...costs.skills.slice(0, ROWS_SHOWN).map(one =>
                      line(
                        `cost-${one.key}`,
                        [
                          giving(
                            'n',
                            <Text wrap="truncate-end">
                              {`/${one.name}`}
                            </Text>,
                          ),
                          one.isUnused ? chip('u', 'unused', TONES.warn) : null,
                        ],
                        <Text dimColor tabular>{`${amount(one.tokens)} tok · ≈${credsText(costs.soFar([one.key]))} so far`}</Text>,
                        insetRoom,
                      ),
                    ),
                    more(costs.skills.length - ROWS_SHOWN, 'more-cost-skills'),
                  ])
                : null}
            </Box>
          ) : null,
          weights.files.length
            ? costLine(
                'cost-files',
                [
                  <Text key="n" weight="medium">
                    {`Memory files · ${weights.files.length}`}
                  </Text>,
                ],
                total(weights.files),
              )
            : null,
          ...(weights.onDemand.length === 1
            ? quiet('1 more connector loads its tools only when Claude searches for them, so it costs nothing yet.')
            : weights.onDemand.length
              ? quiet(`${weights.onDemand.length} more connectors load their tools only when Claude searches for them, so they cost nothing yet.`)
              : []),
        ]
      : quiet('Counting what loads into every message…')

    // The header: the pane's own label over its title, and Copy and Hide as pills. Then the summary
    // card, and a card for each section, each list with its sort where it has more than one row.
    const sortIf = (id: string, rows: number, options: readonly string[]) => (rows > 1 ? sorter(id, ['newest', ...options]) : null)
    return (
      <Box flexDirection="column" width={width} rowGap={1}>
        <Box key="top" flexDirection="row" alignItems="center" width={width} columnGap={1}>
          <Box flexDirection="column" flexGrow={1}>
            {eyebrow('top-l', 'chat-monitor')}
            <Text weight="semibold" size="heading">
              {TITLE}
            </Text>
          </Box>
          <Button key="copy" label="Copy" variant="secondary" onPress={nothing} />
          <Button key="hide" label="Hide" plain dimColor onPress={nothing} />
        </Box>
        <Box key="session" flexDirection="column" borderStyle="round" {...(isRich ? { borderColor: LINE } : { borderDimColor: true })} paddingLeft={PAD_LEFT} paddingRight={PAD_RIGHT} paddingY={isRich ? 1 : 0} width={width} flexShrink={0}>
          {sessionBody as never}
        </Box>
        {card('todo', 'to-do', plan.steps.length ? `${done} of ${plan.steps.length}` : '', todoBody)}
        {card('connectors', 'connectors', connectors.length ? String(connectors.length) : '', connectorBody, sortIf('connectors', connectors.length, ['most calls', 'a to z']))}
        {card('web', 'web', sites.length || list.searches.length ? String(sites.length + list.searches.length) : '', webBody, sortIf('web', sites.length, ['most pages', 'a to z']))}
        {card('agents', 'subagents', agents.length ? String(agents.length) : '', agentBody)}
        {card('files', 'files', files.length ? String(files.length) : '', fileBody, sortIf('files', files.length, ['edited first', 'a to z']))}
        {card('skills', 'skills', skills.length ? `${skills.length}${skillsTotal ? ` · ≈${credsText(skillsTotal)} creds` : ''}` : '', skillBody, sortIf('skills', skills.length, ['most creds', 'a to z']))}
        {card('cost', 'context cost', weights.at ? `≈${amount(costs.perMessage(costs.allTokens))} a message` : '', costBody)}
      </Box>
    )
  })
}
