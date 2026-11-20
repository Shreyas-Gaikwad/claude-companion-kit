import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Limit, Step, Switch, TurnUse, View, Warm, Work } from '../types'

// One slim row above the prompt, in three parts: how far the work on the latest prompt has come,
// how much of the 5-hour limit is used, and how long the prompt cache stays warm, with what a send
// would cost in creds once it has gone cold.
// A chevron opens the details below it: the full step list, both limits with their exact reset
// times, what this prompt has used, and the context window with a Compact button.
// /keepwarm keeps the cache warm through a break with one small ping per idle stretch, and says
// how long it holds it on a status line below the band, beside the model picker.
// On the desktop, the editor and the phone the row's pictures move by themselves (see Motion): its
// bars slide to new lengths, a shimmer crosses the task's bar while Claude works, the clock's ring
// drains with the cache, and the cooling dot fades. The details' bars hold still.

const TICK_MS = 5_000
/** In the cache's last minutes the band redraws every second, so the countdown and its pulse move. */
const FAST_MS = 1_000
const WARN_MS = 5 * 60_000
/** A turn at least this long rings when it ends. */
const LONG_TURN_MS = 60_000
/** A cold send of at least this many creds is drawn amber ($0.40), and red from the next. */
const DEAR_SEND = 100_000
const COSTLY_SEND = 300_000
const ACCENT = 'claude'
const GOOD = 'success'
const WARN = 'warning'
const BAD = 'error'

// The to-do list comes from whichever list tool the chat uses.
const DESKTOP_PLAN = 'mcp__ccd_turn__update_plan'
const DESKTOP_WRAP = 'mcp__ccd_turn__wrap_up'
const PLAN_TOOLS = new Set([DESKTOP_PLAN, DESKTOP_WRAP, 'TodoWrite', 'TaskCreate', 'TaskUpdate'])

const NO_WORK: Work = { startedAt: 0, endedAt: 0, tools: 0, steps: [] }
const NO_USE: TurnUse = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costFrom: -1,
  cost: -1,
  weighted: 0,
  fiveFrom: null,
  weekFrom: null,
  fiveCarried: 0,
  weekCarried: 0,
}
const CLOSED: View = { isOpen: false, compact: 'idle' }
const workAtom = atom({ plugin: 'taskband', key: 'work' } as const, NO_WORK, { shape: 'work-1' })
const limitAtom = atom({ plugin: 'taskband', key: 'limit' } as const, null as Limit | null, { shape: 'limit-1' })
const weekAtom = atom({ plugin: 'taskband', key: 'week' } as const, null as Limit | null, { shape: 'limit-1' })
const useAtom = atom({ plugin: 'taskband', key: 'use' } as const, NO_USE, { shape: 'use-5' })
const contextAtom = atom({ plugin: 'taskband', key: 'context' } as const, null as Context | null, { shape: 'context-1' })
const viewAtom = atom({ plugin: 'taskband', key: 'view' } as const, CLOSED, { shape: 'view-1' })
const cacheAtom = atom({ plugin: 'taskband', key: 'cacheAt' } as const, 0, { shape: 'cache-1' })
const nowAtom = atom({ plugin: 'taskband', key: 'now' } as const, 0, { shape: 'now-1' })
const modelAtom = atom({ plugin: 'taskband', key: 'model' } as const, '', { shape: 'model-1' })
const prefixesAtom = atom({ plugin: 'taskband', key: 'prefixes' } as const, {} as Record<string, number>, { shape: 'prefixes-1' })
const switchAtom = atom({ plugin: 'taskband', key: 'switched' } as const, null as Switch | null, { shape: 'switch-1' })
let cacheLife = 60 * 60_000
let isCacheAlertOn = false
let isSoundOn = true
let ticking: unknown
let fastTicking: unknown
/** The cache refresh the cooling notice was last sent for, so it is sent once per refresh. */
let alertedFor = 0
/** The auto-compaction point in tokens, read once a session; 0 when unknown or off. */
let compactTokens = 0
/** The fill Claude Code last reported for the live window; 0 while it reports none, as in a chat reopened before its first reply. */
let liveTokens = 0
/** A compaction or /clear was asked for or announced, so an empty fill is its doing even with no fill seen before it. */
let isEmptying = false
/** /clear ended the conversation, so the fill it empties is a new chat's, not a compaction's. */
let isCleared = false
/** The cache clock a compaction left. The send after it writes only the summary: no break to keep warm after. */
let compactedCacheAt = 0
/** This turn began on a cold cache, so its first request measures how much of the prompt stayed cached. */
let isMeasuringPrefix = false

// ---- The progress pill ----

type Tone = typeof ACCENT | typeof GOOD | typeof WARN | typeof BAD
// A picture cannot read the theme, so each tone has a color that holds on light and dark.
const HEX: Record<Tone, string> = { claude: '#d97757', success: '#16a34a', warning: '#d97706', error: '#dc2626' }
const PILL_HEIGHT = 8

// ---- Motion ----
//
// The band's pictures move by themselves: SMIL inside the SVG, which the desktop, the editor and the
// mobile app play at the screen's own frame rate, with no redraw and no request. Two rules keep it
// smooth. A redraw that hands a picture a new source starts it again, so a source is kept as built
// while what it shows is unchanged: the same string is the same picture, still moving. And every
// motion is set against the clock rather than the picture's load, so one built again mid-motion
// picks up exactly where the last one was. The terminal draws no pictures and keeps its text.

/** How long a bar takes to slide to a new length. */
const SLIDE_MS = 700
/** One shimmer across the filled part and a rest after it, while Claude works. */
const SHIMMER_MS = 2_400
/** The share of a shimmer's period it spends crossing; the rest it waits. */
const SHIMMER_CROSS = 0.6
/** One fade of the cooling dot, down and back up. */
const BREATH_MS = 1_600
/** A picture that moves on its own is built again at most this often, so one drawn afresh is never far off. */
const REBUILD_MS = 30_000
/** Ease-out, as a cubic curve: quick to start, soft to land. `easeOut` follows the same curve. */
const EASE_OUT = '0.33 1 0.68 1'
const EASE_IN_OUT = '0.45 0 0.55 1'
const easeOut = (x: number) => 1 - (1 - x) ** 3

/** Milliseconds as SMIL seconds. */
const secs = (ms: number) => `${(ms / 1000).toFixed(3)}s`
/** Where a repeating motion of `period` stands at `at`: its begin set back by that much, so every copy keeps one phase. */
const phaseAt = (at: number, period: number) => secs(-(((at % period) + period) % period))

type Built = { deps: string; source: string; until: number }
/** Each picture as last built, by where it is drawn. */
const built = new Map<string, Built>()
/** The source for `where`: the one built before while `deps` holds and its time has not run out, else a new one. */
function steady(where: string, deps: string, at: number, build: () => { source: string; until: number }): string {
  const old = built.get(where)
  if (old && old.deps === deps && (!old.until || at < old.until)) return old.source
  const made = build()
  built.set(where, { deps, ...made })
  return made.source
}

/** A bar's length, and the slide that brought it there. */
type Slide = { from: number; to: number; at: number }
/** Each bar's slide, by where it is drawn. */
const slides = new Map<string, Slide>()
/** Where a slide stands at `at`, as a share. */
function shareAt(slide: Slide, at: number) {
  const x = Math.min(1, Math.max(0, (at - slide.at) / SLIDE_MS))
  return slide.from + (slide.to - slide.from) * easeOut(x)
}
/**
 * The slide that shows `share` at `at`. A new share slides from wherever the bar stands now, a slide
 * under way included; the first sight of a bar has nothing to slide from.
 */
function slideTo(where: string, share: number, at: number): Slide {
  const old = slides.get(where)
  if (old && old.to === share) return old
  const next: Slide = old ? { from: shareAt(old, at), to: share, at } : { from: share, to: share, at: 0 }
  slides.set(where, next)
  return next
}

/** How a pill moves: its slide, how far into it this picture begins, and a shimmer's phase while Claude works. */
type PillMotion = { from: number; into: number; shimmer?: string }

/** A rounded track, a fifth as strong as its fill, with the filled share from the left. */
function pill(share: number, hex: string, width: number, motion?: PillMotion): string {
  const radius = PILL_HEIGHT / 2
  // A sliver of progress still shows as a full round end.
  const lengthOf = (one: number) => (one <= 0 ? 0 : Math.max(PILL_HEIGHT, Math.round(one * width)))
  const filled = lengthOf(share)
  const start = motion ? lengthOf(motion.from) : filled
  const isSliding = start !== filled
  // The fill slides from its old length, eased out; frozen at the new one once there.
  const slide = isSliding
    ? `<animate attributeName="width" from="${start}" to="${filled}" begin="${secs(-(motion?.into ?? 0))}" dur="${secs(SLIDE_MS)}" calcMode="spline" keyTimes="0;1" keySplines="${EASE_OUT}" fill="freeze"/>`
    : ''
  const fill = () => `<rect width="${isSliding ? start : filled}" height="${PILL_HEIGHT}" rx="${radius}" fill="${hex}">${slide}</rect>`
  // A soft light crosses the filled part, then rests: clipped to the fill, so it slides with it.
  // With nothing filled yet, a faint wash of the bar's own colour crosses the empty track instead.
  const band = Math.max(16, Math.round(width * 0.4))
  const hasFill = !!(filled || start)
  const track = `<rect width="${width}" height="${PILL_HEIGHT}" rx="${radius}"/>`
  const [light, strength] = hasFill ? ['#fff', '0.55'] : [hex, '0.5']
  const shimmer = motion?.shimmer
      ? `<defs><clipPath id="f">${hasFill ? fill() : track}</clipPath><linearGradient id="s"><stop offset="0" stop-color="${light}" stop-opacity="0"/><stop offset="0.5" stop-color="${light}" stop-opacity="${strength}"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></linearGradient></defs>` +
        `<rect x="${-band}" width="${band}" height="${PILL_HEIGHT}" fill="url(#s)" clip-path="url(#f)">` +
        `<animate attributeName="x" values="${-band};${width};${width}" keyTimes="0;${SHIMMER_CROSS};1" calcMode="spline" keySplines="${EASE_IN_OUT};0 0 1 1" dur="${secs(SHIMMER_MS)}" begin="${motion.shimmer}" repeatCount="indefinite"/></rect>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${PILL_HEIGHT}" width="${width}" height="${PILL_HEIGHT}">` +
    `<rect width="${width}" height="${PILL_HEIGHT}" rx="${radius}" fill="${hex}" fill-opacity="0.2"/>` +
    (filled || start ? fill() : '') +
    shimmer +
    '</svg>'
  )
}

/** The cooling dot: it fades down and back up, in step with the clock, so a picture built again keeps its beat. */
function dotIcon(hex: string, at: number): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" width="8" height="8">' +
    `<circle cx="4" cy="4" r="3.5" fill="${hex}">` +
    `<animate attributeName="opacity" values="1;0.25;1" keyTimes="0;0.5;1" calcMode="spline" keySplines="${EASE_IN_OUT};${EASE_IN_OUT}" dur="${secs(BREATH_MS)}" begin="${phaseAt(at, BREATH_MS)}" repeatCount="indefinite"/>` +
    '</circle></svg>'
  )
}

// ---- The cache's tooltip ----

const CLOCK_SIZE = 14
const CLOCK_GREY = '#8a8a8a'

/** The clock's ring, all the way round. */
const RING_LENGTH = 2 * Math.PI * 5.6

/**
 * How the clock's ring drains: over the cache's whole life, `elapsed` of it gone when this picture
 * begins, turning red when `warnIn` more has passed (the cache's last five minutes). Absent, the
 * cache holds nothing and the ring is empty.
 */
type RingMotion = { life: number; elapsed: number; warnIn: number; red: string }

/**
 * A small clock in a grey that holds on light and dark, carrying the desktop app's own tooltip:
 * only a picture drawn interactive can, by its `<title>`. The whole square answers the pointer.
 * Its ring is the cache: full when refreshed, it empties smoothly as the cache cools, by itself.
 */
function clockIcon(tip: string, ring?: RingMotion): string {
  const said = tip.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const round = RING_LENGTH.toFixed(2)
  // Drawn from twelve o'clock, clockwise: the dash slides off as the cache's life runs out.
  const drain = ring
    ? `<circle cx="7" cy="7" r="5.6" fill="none" stroke="${CLOCK_GREY}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="${round}" stroke-dashoffset="0" transform="rotate(-90 7 7)">` +
      `<animate attributeName="stroke-dashoffset" from="0" to="${round}" begin="${secs(-ring.elapsed)}" dur="${secs(ring.life)}" fill="freeze"/>` +
      `<set attributeName="stroke" to="${ring.red}" begin="${secs(ring.warnIn)}" fill="freeze"/>` +
      '</circle>'
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}" width="${CLOCK_SIZE}" height="${CLOCK_SIZE}">` +
    `<g><title>${said}</title>` +
    `<rect width="${CLOCK_SIZE}" height="${CLOCK_SIZE}" fill="#000" fill-opacity="0"/>` +
    `<circle cx="7" cy="7" r="5.6" fill="none" stroke="${CLOCK_GREY}" stroke-opacity="0.3" stroke-width="1.6"/>` +
    drain +
    `<path d="M7 4.6V7l1.6 1" fill="none" stroke="${CLOCK_GREY}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>` +
    '</g></svg>'
  )
}

// ---- Wording ----

const two = (n: number) => String(n).padStart(2, '0')
/** "45s", "2m 15s", "1h 05m". */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${two(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
}
/** A countdown: "52m" while there is time, "4:35" in the last ten minutes, "2d 04h" past a day. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d ${two(Math.floor((seconds % 86_400) / 3600))}h`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`
  if (seconds >= 600) return `${Math.ceil(seconds / 60)}m`
  return `${Math.floor(seconds / 60)}:${two(seconds % 60)}`
}
/** The cache's countdown, always in minutes: "60m" just refreshed, down to "10m", then "9:59" in its last ten minutes. */
function cacheCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return seconds >= 600 ? `${Math.ceil(seconds / 60)}m` : countdown(ms)
}
/** "980", "12.4k", "48k", "1.2M". */
function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
const dollars = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** The local clock time of a moment, with its weekday when it is not today: "4:12 PM", "Mon 9:00 AM". */
function clockTime(at: number, now: number): string {
  const when = new Date(at)
  let time: string
  try {
    time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    time = `${two(when.getHours())}:${two(when.getMinutes())}`
  }
  return new Date(now).toDateString() === when.toDateString() ? time : `${DAYS[when.getDay()]} ${time}`
}
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}
// ---- Creds ----
//
// A cred is a token counted at its price, in tokens of Claude Opus 5.5 input ($4 per million), so
// one cred is $0.000004 of usage whichever model answered. Where Claude Code keeps a cost ledger,
// a turn's creds are its cost ÷ $4 per million, and a ping's are what it moved the ledger by.
// What has not been sent yet (a cold send, a ping) is forecast from this table:
//
//   creds = (model's input price ÷ $4) × (new + r × cache read + c × cache write + 5 × out)
//
// r is the model's cache-read share of its input price, c is 2 for the 1-hour cache and 1.25 for
// the 5-minute one, and output costs five times input on every current model. Effort needs no
// term of its own: what a higher effort costs is the thinking and the extra steps it adds, which
// arrive as output tokens and as more requests, and are counted there.

/** The input price in dollars per million tokens and the cache-read share of it, by model; the first match wins. */
const PRICES: readonly (readonly [string, number, number])[] = [
  ['fable-5-2', 8, 0.025],
  ['mythos-5-2', 8, 0.025],
  ['fable-5-1', 10, 0.025],
  ['mythos-5-1', 10, 0.025],
  ['fable-5', 10, 0.1],
  ['mythos-5', 10, 0.1],
  ['opus-5-5', 4, 0.05],
  ['opus-5', 5, 0.1],
  ['opus-4-1', 15, 0.1],
  ['opus-4-20', 15, 0.1],
  ['opus-4', 5, 0.1],
  ['sonnet-5-5', 2, 0.05],
  ['sonnet-5', 2, 0.1],
  ['sonnet-4', 3, 0.1],
  ['haiku-5-5', 0.1, 0.1],
  ['haiku-4', 1, 0.1],
  ['haiku-3-5', 0.8, 0.1],
]
const REFERENCE_PRICE = 4
const OUTPUT_TIMES = 5
/**
 * What one cred stands for, in dollars. Claude Code prices every request itself (fast mode, new
 * models and price changes included, as it is updated), so its ledger comes first and the table
 * above is only the fallback for a host with no ledger.
 */
const DOLLARS_PER_CRED = REFERENCE_PRICE / 1_000_000

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }

/** A model's input price in dollars per million for a prompt of this many tokens, and its cache-read share. */
function priceOf(model: string | undefined, prompt: number): [number, number] {
  const name = (model ?? '').toLowerCase()
  // An id as a response names it first; else the model /model names, as "Sonnet 5.5 (1M context)".
  const key = modelKey(name)
  const [one, listed, readShare] = PRICES.find(([id]) => name.includes(id)) ?? PRICES.find(([id]) => key.includes(id)) ?? ['', REFERENCE_PRICE, 0.05]
  // Claude Haiku 5.5 costs five times as much on a prompt over 100k tokens.
  return [one === 'haiku-5-5' && prompt > 100_000 ? 0.5 : listed, readShare]
}

/** A cache write costs twice the input price on the 1-hour cache, 1.25 times on the 5-minute one. */
const writeTimes = () => (cacheLife > 5 * 60_000 ? 2 : 1.25)

/** One request's tokens, weighted by its model's prices. */
function weigh(used: Usage): number {
  const input = used.input_tokens || 0
  const read = used.cache_read_input_tokens || 0
  const write = used.cache_creation_input_tokens || 0
  const output = used.output_tokens || 0
  const [price, readShare] = priceOf(used.model, input + read + write)
  return (price / REFERENCE_PRICE) * (input + readShare * read + writeTimes() * write + OUTPUT_TIMES * output)
}

/**
 * One model, read the same from a response, a switch or /model: "claude-opus-5-5[1m]",
 * "claude-opus-4-1-20250805" and "Opus 5.5 (1M context)" give "claude-opus-5-5", "claude-opus-4-1"
 * and "claude-opus-5-5". An alias with no version, such as "opus", is left as it is.
 */
function modelKey(model: string) {
  const text = model.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim()
  const found = /^(?:claude[- ])?([a-z]+)[- ](\d+)(?:[.-](\d{1,2}))?(?!\d)/.exec(text)
  return found ? `claude-${found[1]}-${found[2]}${found[3] ? `-${found[3]}` : ''}` : text
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; an id of another form as it is. */
function modelName(model: string) {
  const key = modelKey(model)
  const found = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(key)
  return found ? `${found[1]!.charAt(0).toUpperCase()}${found[1]!.slice(1)} ${found[2]!.replace('-', '.')}` : key
}

/** The head of the prompt measured still cached on this model; 0 for one never measured. */
const prefixFor = (prefixes: Record<string, number>, model: string) => prefixes[modelKey(model)] ?? 0

/**
 * What a send into a cold cache costs before the reply, in creds: the context is written to the
 * cache again, all but its head (the tools and system prompt), which the last cold send on this
 * model measured still cached and is read. Taken from the context the last response was answered over.
 */
function coldCreds(model: string, context: number, prefix: number) {
  const [price, readShare] = priceOf(model, context)
  const kept = Math.max(0, Math.min(prefix, context))
  return (price / REFERENCE_PRICE) * (writeTimes() * (context - kept) + readShare * kept)
}

/**
 * The first request of a send into a cold cache, the first after a compaction, or the first on a
 * model switched to: what it read from the cache is the head of the prompt that stays cached on
 * that model when the chat's own part does not. Each model keeps its own: one the person seldom
 * uses may have none of it cached. One that read nearly all its prompt found the cache warm after
 * all, and measures nothing.
 */
async function measurePrefix($: EngineInterface, used: Usage, model: string) {
  const key = modelKey(model)
  const read = used.cache_read_input_tokens || 0
  const prompt = read + (used.cache_creation_input_tokens || 0) + (used.input_tokens || 0)
  if (!key || !prompt || read > 0.9 * prompt) return
  const prefixes = await update($, prefixesAtom, old => ({ ...old, [key]: read }))
  await storeSet($, KEY_PREFIXES, prefixes)
}

/** What a send into a warm cache pays for the same context: a read of it. */
function warmCreds(model: string, context: number) {
  const [price, readShare] = priceOf(model, context)
  return (price / REFERENCE_PRICE) * readShare * context
}


/** Claude Code's cost so far, in dollars; -1 where there is no ledger. */
async function ledgerUsd($: EngineInterface): Promise<number> {
  const usage = await $.session.usage().catch(() => undefined)
  return typeof usage?.cost?.usd === 'number' ? usage.cost.usd : -1
}

// ---- How far a turn moves each limit ----
//
// A turn keeps the reading its limit stood at when it began. When the window turns over during
// the turn, what the turn took of the old window (its last reading less where the turn began) is
// carried, and the new window counts from zero, so a long turn that runs a window to its end and
// on into the next reads as the sum of both.

const isSameReset = (a: number, b: number) => Math.abs(a - b) < 10 * 60_000

/**
 * Moves a turn's starting reading on to a new window: `from` is where the turn began in the
 * window it is in, `old` the reading before this one, `latest` this one.
 */
function rebase(from: Limit | null, carried: number, old: Limit | null, latest: Limit | null): [Limit | null, number] {
  if (!from || !latest || !latest.resetsAt) return [from, carried]
  // A turn that began after its window ran out has its window dated by the first reading of the new one.
  if (!from.resetsAt) return [{ percentUsed: from.percentUsed, resetsAt: latest.resetsAt }, carried]
  if (isSameReset(latest.resetsAt, from.resetsAt)) return [from, carried]
  const oldLast = old && isSameReset(old.resetsAt, from.resetsAt) ? old.percentUsed : from.percentUsed
  return [{ percentUsed: 0, resetsAt: latest.resetsAt }, carried + Math.max(0, oldLast - from.percentUsed)]
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

const mark = (steps: Step[], pick: (step: Step, i: number) => boolean, status: Step['status']) => steps.map((step, i) => (pick(step, i) ? { ...step, status } : step))

/** The steps after one call to a list tool, or undefined when the call changes nothing. */
function stepsAfter(steps: Step[], tool: string, input: Record<string, unknown>, result: unknown): Step[] | undefined {
  if (tool === 'TodoWrite') return stepsOf(input.todos)
  if (tool === DESKTOP_PLAN) {
    if (Array.isArray(input.items)) return stepsOf(input.items)
    let after = steps
    if (input.advance === true) {
      // The running step is done and the next waiting one starts.
      const running = after.findIndex(step => step.status === 'in_progress')
      after = mark(after, (_, i) => i === running, 'completed')
      const waiting = after.findIndex(step => step.status === 'pending')
      after = mark(after, (_, i) => i === waiting, 'in_progress')
    }
    // "done" and "start" count steps from 1.
    const done = Array.isArray(input.done) ? input.done.filter((n): n is number => typeof n === 'number') : []
    if (done.length) after = mark(after, (_, i) => done.includes(i + 1), 'completed')
    if (typeof input.start === 'number') after = mark(after, (_, i) => i + 1 === input.start, 'in_progress')
    return after === steps ? undefined : after
  }
  // Wrapping up closes the task: the desktop app checks off the whole list, steps never started included.
  if (tool === DESKTOP_WRAP) return steps.some(step => step.status !== 'completed') ? mark(steps, () => true, 'completed') : undefined
  if (tool === 'TaskCreate') {
    const text = textOf(input.subject)
    if (!text) return undefined
    const made = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const id = typeof made === 'string' || typeof made === 'number' ? String(made) : String(steps.length + 1)
    const active = textOf(input.activeForm)
    return [...steps, { text, status: 'pending', id, ...(active ? { active } : {}) }]
  }
  if (tool === 'TaskUpdate') {
    const id = typeof input.taskId === 'number' ? String(input.taskId) : textOf(input.taskId)
    const index = steps.findIndex(step => step.id === id)
    const old = steps[index]
    if (!old) return undefined
    if (input.status === 'deleted') return steps.filter((_, i) => i !== index)
    const active = textOf(input.activeForm) || old.active
    const changed: Step = { ...old, text: textOf(input.subject) || old.text, status: input.status === undefined ? old.status : statusOf(input.status), ...(active ? { active } : {}) }
    return steps.map((step, i) => (i === index ? changed : step))
  }
  return undefined
}

/**
 * Carries each step's times over from the list before, matched by id or wording, and stamps what
 * changed: a step seen starting gets its start, and one of those checked off gets its end. A step
 * checked off without ever being seen running has no time, rather than a guessed one.
 */
function timeSteps(before: Step[], after: Step[], now: number): Step[] {
  const known = new Map(before.map(step => [step.id ?? step.text, step]))
  return after.map(step => {
    const was = known.get(step.id ?? step.text)
    const { startedAt: _start, endedAt: _end, ...rest } = step
    if (step.status === 'pending') return rest
    const startedAt = step.startedAt ?? was?.startedAt ?? (step.status === 'in_progress' ? now : undefined)
    if (!startedAt) return rest
    if (step.status === 'in_progress') return { ...rest, startedAt }
    return { ...rest, startedAt, endedAt: step.endedAt ?? was?.endedAt ?? now }
  })
}

// ---- Keeping the figures ----

type Windows = readonly { kind: string; percentUsed: number; resetsAt?: string }[] | undefined

function limitOf(windows: Windows, kind: 'five_hour' | 'seven_day'): Limit | null {
  const window = windows?.find(one => one.kind === kind)
  if (!window) return null
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return { percentUsed: window.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0 }
}

async function keepLimits($: EngineInterface, windows: Windows) {
  const five = limitOf(windows, 'five_hour')
  const seven = limitOf(windows, 'seven_day')
  if (five) await update($, limitAtom, () => five)
  if (seven) await update($, weekAtom, () => seven)
}

async function keepContext($: EngineInterface, context: { tokens?: number; window: number } | undefined) {
  if (!context || !context.window) return
  const window = context.window
  if (typeof context.tokens === 'number') {
    liveTokens = context.tokens
    isEmptying = false
    isCleared = false
    const next: Context = { tokens: context.tokens, window, compactAt: compactTokens }
    await update($, contextAtom, () => next)
    return
  }
  // No fill: a compaction or /clear emptied it, or the chat has had no reply in this process yet,
  // where the figure the band kept from its last run stands.
  if (liveTokens > 0 || isEmptying) return fillGone($)
  await update($, contextAtom, old => (old && old.tokens > 0 ? { ...old, window } : { tokens: -1, window, compactAt: compactTokens }))
}

// ---- After a compaction or /clear ----
//
// Claude Code reports no fill for the live window from a compaction (or /clear) until the next
// reply. Between turns the band asks for it every tick, so a /compact, typed or run by the band,
// shows at once, even where an organization keeps the compaction event itself from installed
// plugins. The new size is counted as /context counts it, with the token-counting service.

/** Between turns: has the fill Claude Code reported gone? */
async function watchFill($: EngineInterface) {
  if ((liveTokens <= 0 && !isEmptying) || isPinging) return
  const work = await read($, workAtom)
  if (work.startedAt > 0 && !work.endedAt) return
  const usage = await $.session.usage().catch(() => undefined)
  if (usage?.context.window && typeof usage.context.tokens !== 'number') await fillGone($)
}

/**
 * A compaction left a summary where the chat was, or /clear began a new chat, and the cache holds
 * none of it yet. After a compaction the cache reads cold, with what the next send costs, and
 * keepwarm waits for that send; after /clear it has not started.
 */
async function fillGone($: EngineInterface) {
  if (liveTokens <= 0 && !isEmptying) return
  liveTokens = 0
  isEmptying = false
  const wasCleared = isCleared
  isCleared = false
  const now = await $.clock.now()
  if (wasCleared) {
    hasHistory = false
    await update($, cacheAtom, () => 0)
  } else {
    compactedCacheAt = now - cacheLife
    await update($, cacheAtom, () => compactedCacheAt)
    await afterCompaction($)
  }
  await update($, nowAtom, () => now)
  await arm($).catch(noop)
  const usage = await $.session.usage({ breakdown: 'full' }).catch(() => undefined)
  // A reply that came in meanwhile brought the figure itself.
  if (liveTokens > 0) return
  const counted = usage?.context.breakdown?.totalTokens
  await update($, contextAtom, old => {
    const window = usage?.context.window || old?.window
    if (!window) return old
    return { tokens: typeof counted === 'number' && counted > 0 ? counted : -1, window, compactAt: compactTokens || old?.compactAt || 0 }
  })
  await saveCache($)
}

// ---- A model switch ----
//
// None of the chat is cached on a model switched to, so the next send writes it there, at that
// model's prices, and keepwarm holds its pings until that send. Switching back before a send finds
// the cache where it was.

/**
 * The model the next send goes to is `to`; the chat's cache is on `from`, or, with none given, on
 * the model the main thread last asked. A name the band cannot read as a model (an alias such as
 * "opus") changes nothing.
 */
async function noteModel($: EngineInterface, to: string, from: string) {
  const goesTo = modelKey(to)
  if (!goesTo.startsWith('claude-')) return
  const before = await read($, switchAtom)
  const cachedOn = before?.from || from || (await read($, modelAtom))
  if (!modelKey(cachedOn).startsWith('claude-')) return
  const after: Switch | null = goesTo === modelKey(cachedOn) ? null : { from: cachedOn, to }
  if ((before ? modelKey(before.to) : '') === (after ? modelKey(after.to) : '')) return
  await update($, switchAtom, () => after)
  await arm($)
}

/** Between turns: has the model been switched, as /model or the picker does? */
async function watchModel($: EngineInterface) {
  const work = await read($, workAtom)
  if ((work.startedAt > 0 && !work.endedAt) || isPinging) return
  const chosen = await $.session.model().catch(() => '')
  if (chosen) await noteModel($, chosen, '')
}

/** A request went out just now, so the cache is fresh from this moment. */
async function touchCache($: EngineInterface) {
  const now = await $.clock.now()
  await update($, cacheAtom, () => now)
  return now
}

/** Moves the band's clock on, but only while something on it is counting. */
async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const work = await read($, workAtom)
  const cacheAt = await read($, cacheAtom)
  const limit = await read($, limitAtom)
  const isWorking = work.startedAt > 0 && !work.endedAt
  // One step past the end, so the band is drawn once more to say "cold" or "resets soon".
  const isCacheCounting = cacheAt > 0 && now - cacheAt < cacheLife + 2 * TICK_MS
  const isLimitCounting = !!limit && limit.resetsAt > 0 && now < limit.resetsAt + 2 * TICK_MS
  const warm = await read($, warmAtom)
  const isWarmCounting = warm.deadline > 0 && now < warm.deadline + 2 * TICK_MS
  if (isWorking || isCacheCounting || isLimitCounting || isWarmCounting) await update($, nowAtom, () => now)
  // Keepwarm's status line counts down in minutes; it is sent only when its words change.
  await showWarm($)
  await watchFill($)
  await watchModel($)
}

/** Every second in the cache's last minutes: redraws the pulse and sends the cooling notice once. */
async function fastTick($: EngineInterface) {
  const cacheAt = await read($, cacheAtom)
  if (!cacheAt) return
  const now = await $.clock.now()
  const left = cacheAt + cacheLife - now
  if (left <= 0 || left > WARN_MS) return
  await update($, nowAtom, () => now)
  const work = await read($, workAtom)
  const isWorking = work.startedAt > 0 && !work.endedAt
  if (isCacheAlertOn && !isWorking && alertedFor !== cacheAt) {
    alertedFor = cacheAt
    const minutes = Math.max(1, Math.round(left / 60_000))
    await $.ui
      .notify(`The prompt cache goes cold in ${minutes} minute${minutes === 1 ? '' : 's'}. Send a message to keep it warm.`, { title: 'Cache cooling', key: 'cache' })
      .catch(() => undefined)
  }
}

// powershell.exe takes a whole script as UTF-16LE base64, which sidesteps every quoting rule.
function utf16Base64(text: string) {
  let raw = ''
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    raw += String.fromCharCode(unit & 0xff, unit >> 8)
  }
  return btoa(raw)
}

const RING =
  "$p = Join-Path $env:SystemRoot 'Media\\Windows Notify System Generic.wav'; " +
  'if (Test-Path $p) { (New-Object Media.SoundPlayer $p).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800 }'

/** A short Windows chime. The engine's own player is silent on Windows, so the system plays it. */
async function ring($: EngineInterface) {
  await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', utf16Base64(RING)], { timeoutMs: 10_000 }).catch(() => undefined)
}

/** A toast that never throws: $.ui.toast returns nothing to catch on, and a failed hint is no failure. */
function say($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // The toast is only a hint.
  }
}

/**
 * Runs /compact as if typed: queued, it runs once the session is idle. Where $.session.compact is
 * refused, as in a -p run or an SDK host such as the desktop app's Code tab, this is how the chat compacts.
 */
async function compactByCommand($: EngineInterface) {
  try {
    await $.command.run({ command: 'compact' })
  } catch {
    say($, 'The band cannot compact this chat. Type /compact instead.')
    return
  }
  // The command may still be queued: the band's tick sees the fill go when it has run.
  isEmptying = true
  await watchFill($)
  say($, 'Chat compacted.')
}

/** The summary replaced the chat the cache holds: keepwarm's pings wait for the first request over it. */
async function afterCompaction($: EngineInterface) {
  await update($, warmAtom, warm => (warm.waiting ? warm : { ...warm, waiting: true })).catch(noop)
}

/** Compacts the chat once the press has returned, so the band can say it is working. */
async function compactNow($: EngineInterface) {
  await update($, viewAtom, view => ({ ...view, compact: 'running' }))
  $.clock.after(0, () => {
    void (async () => {
      try {
        const done = await $.session.compact()
        const skip = (done as { skip?: unknown } | undefined)?.skip
        if (skip) say($, `The chat was not compacted: ${String(skip)}`)
        else {
          isEmptying = true
          await watchFill($)
          say($, 'Chat compacted.')
        }
      } catch {
        // Refused, as where compaction runs only inside a turn: compact the way the person would.
        await compactByCommand($)
      } finally {
        await update($, viewAtom, view => ({ ...view, compact: 'idle' }))
      }
    })()
  })
}

// ---- Keepwarm ----
//
// While a window is open, the cache is kept warm through a break: once the chat has sat idle for
// `every` (50 minutes of the cache's hour), one tool-less fork of the chat asks for a single word.
// The fork re-sends the conversation as the main thread last sent it, so the cache serves it as a
// read and its hour starts again. The readback says whether it worked: a ping that read nothing,
// or wrote a tenth of what it read or more, found the cache gone, and keepwarm stops. A busy API
// is tried again after 1, 2 and 4 minutes while a ping can still land before the cache goes cold.
// A cold or unknown cache is never pinged: the next turn writes it and the pings follow that.

const PING_AFTER_MS = 50 * 60_000
const MIN_PING_MS = 60_000
const HOUR_MS = 60 * 60_000
const DEFAULT_WINDOW_MS = 6 * HOUR_MS
const AUTO_WARM_MS = 3 * HOUR_MS
const MAX_WINDOW_MS = 168 * HOUR_MS
const MAX_RETRIES = 3
/** A cold send of less context than this is too small to arm keepwarm over. */
const BIG_CONTEXT = 20_000
// Naming no effort keeps the cache readable on every model; the prompt asks for haste instead.
const PING_PROMPT = 'Reply at once with the single word: warm. You have no tools, so do not think it over.'
// The window belongs to the session that armed it; always is one switch for every session.
const KEY_DEADLINE = 'keepwarm:'
const KEY_EVERY = 'keepwarm-every:'
const KEY_ALWAYS = 'keepwarm-always'
/** By model, the head of the prompt a cold send last found cached: the same tools and system prompt in every chat. */
const KEY_PREFIXES = 'prefix-by-model'

const NO_WARM: Warm = { deadline: 0, every: PING_AFTER_MS, always: 0, stopped: '', waiting: false, retries: 0, last: null }
const warmAtom = atom({ plugin: 'taskband', key: 'warm' } as const, NO_WARM, { shape: 'warm-1' })

/** The "Auto keepwarm" option: a send that paid for a cold cache arms three hours by itself. */
let isAutoWarm = true
/** The ping timer, or null when none is set. */
let pending: { cancel: () => void } | null = null
/** A ping is out; its usage is no turn's. */
let isPinging = false
/** Bumped when the window it was sent for is gone, so a ping out at that moment is dropped. */
let generation = 0
/** The session the window is kept under. */
let sessionKey = ''
/** This turn began on a cold cache with a large context, so it pays for writing it again. */
let isColdTurn = false
let retryReason = ''

const noop = () => undefined
const isColdAt = (cacheAt: number, now: number) => cacheAt > 0 && now - cacheAt >= cacheLife
const hasHourCache = () => cacheLife >= HOUR_MS
/** "6h", "6h 30m", "50m", "7d". */
function duration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`
  if (!hours) return `${minutes}m`
  return minutes % 60 ? `${hours}h ${two(minutes % 60)}m` : `${hours}h`
}
/** "90m", "2h30m", "6h"; null for anything else. */
function parseDuration(text: string | undefined): number | null {
  const found = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec((text ?? '').trim())
  if (!found || (found[1] === undefined && found[2] === undefined)) return null
  return (Number(found[1] ?? 0) * 60 + Number(found[2] ?? 0)) * 60_000
}
/** The stored always switch: a window from an hour to a week, else off. */
const alwaysOf = (value: unknown) => (typeof value === 'number' && value >= HOUR_MS && value <= MAX_WINDOW_MS ? value : 0)

// The store is a convenience: where it is refused, keepwarm still runs for this process.
async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}
async function storeSet($: EngineInterface, key: string, value: unknown) {
  try {
    await $.store.set(key, value as never)
  } catch {
    // Kept in memory only.
  }
}
async function storeDelete($: EngineInterface, key: string) {
  try {
    await $.store.delete(key)
  } catch {
    // Nothing was kept.
  }
}
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(text)
  } catch {
    // The line is only a hint.
  }
}

async function saveWindow($: EngineInterface, warm: Warm) {
  if (!sessionKey) return
  if (!warm.deadline) {
    await storeDelete($, KEY_DEADLINE + sessionKey)
    await storeDelete($, KEY_EVERY + sessionKey)
    return
  }
  await storeSet($, KEY_DEADLINE + sessionKey, warm.deadline)
  if (warm.every === PING_AFTER_MS) await storeDelete($, KEY_EVERY + sessionKey)
  else await storeSet($, KEY_EVERY + sessionKey, warm.every)
}

/** Keeps the window under the conversation the process runs now: after a resume it moves to the new id. */
async function seat($: EngineInterface) {
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    return
  }
  if (!id || id === sessionKey) return
  const old = sessionKey
  sessionKey = id
  if (old) {
    await storeDelete($, KEY_DEADLINE + old)
    await storeDelete($, KEY_EVERY + old)
  }
  await saveWindow($, await read($, warmAtom))
}

function disarm() {
  pending?.cancel()
  pending = null
}

/** The status line last pinned; null before the first, so a reload replaces what the last load left. */
let shownStatus: string | undefined | null = null

/** "1h 23m", "49m": whole minutes, rounded up, so a minute still to go never reads as none. */
const minutes = (ms: number) => duration(Math.ceil(Math.max(0, ms) / 60_000) * 60_000)

/**
 * The line keepwarm keeps below the band, beside the model picker, while a window is open or
 * after it gave up: "keeping warm ⟳ 2h 54m · ping in 49m · last ping read 27k creds".
 */
function warmLine(warm: Warm, cacheAt: number, now: number, switched: Switch | null): string | undefined {
  if (warm.stopped) return `⟳ stopped: ${warm.stopped}`
  if (!warm.deadline || now >= warm.deadline) return undefined
  const next = !cacheAt
    ? 'first ping after the first turn'
    : isColdAt(cacheAt, now)
      ? 'cache cold, first ping after the next turn'
      : switched
        ? `nothing cached on ${modelName(switched.to)} yet, first ping after the next turn`
        : warm.waiting
        ? 'nothing to fork yet, first ping after the next turn'
        : warm.retries
          ? `API busy, ping retry ${warm.retries} of ${MAX_RETRIES}`
          : `ping in ${minutes(cacheAt + warm.every - now)}`
  // What the last ping's read of the cache cost, in creds.
  const last = warm.last ? ` · last ping read ${tokens(warm.last.creds)} creds` : ''
  return `keeping warm ⟳ ${minutes(warm.deadline - now)}${warm.always ? ' (always)' : ''} · ${next}${last}`
}

/** Pins keepwarm's line, or takes it away, when it has changed. */
async function showWarm($: EngineInterface) {
  const text = warmLine(await read($, warmAtom), await read($, cacheAtom), await $.clock.now(), await read($, switchAtom))
  if (text === shownStatus) return
  shownStatus = text
  try {
    $.ui.status(text)
  } catch {
    // The line is only a hint.
  }
}

/** Sets the one timer the window needs and brings the status line up to date. */
async function arm($: EngineInterface) {
  await schedule($)
  await showWarm($)
}

/** The next ping, or, while nothing may be pinged, the window's end. */
async function schedule($: EngineInterface) {
  const warm = await read($, warmAtom)
  const cacheAt = await read($, cacheAtom)
  const switched = await read($, switchAtom)
  const now = await $.clock.now()
  // From here to the timer nothing awaits, so of two calls at once the later one's timer is the one left.
  disarm()
  if (!warm.deadline) return
  if (now >= warm.deadline) return stopWarm($, '')
  // After a model switch a ping would write the whole chat to the new model: none until a send does.
  if (!cacheAt || isColdAt(cacheAt, now) || warm.waiting || switched) {
    pending = $.clock.after(warm.deadline - now, () => void arm($).catch(noop))
    return
  }
  const delay = Math.min(warm.deadline - now, cacheAt + cacheLife - now, Math.max(1000, cacheAt + warm.every - now))
  pending = $.clock.after(delay, () => void ping($).catch(noop))
}

/** Ends the window; a reason says keepwarm gave up, and is shown until the next window. */
async function stopWarm($: EngineInterface, why: string, forgetAlways = false) {
  generation += 1
  disarm()
  await update($, warmAtom, warm => ({ ...warm, deadline: 0, every: PING_AFTER_MS, stopped: why, retries: 0, always: forgetAlways ? 0 : warm.always }))
  await saveWindow($, NO_WARM)
  if (forgetAlways) await storeDelete($, KEY_ALWAYS)
  if (why) log($, `taskband: keepwarm stopped, ${why}.`)
  await showWarm($)
}

/** Opens a window of this length from now, pinging after `every` of idle. */
async function startWarm($: EngineInterface, length: number, every: number) {
  const now = await $.clock.now()
  const warm = await update($, warmAtom, old => ({ ...old, deadline: now + length, every, stopped: '', retries: 0 }))
  await saveWindow($, warm)
  await arm($)
}

const afterRetries = (count: number) => (count ? ` after ${count} ${count === 1 ? 'retry' : 'retries'}` : '')

async function ping($: EngineInterface) {
  pending = null
  if (isPinging) return
  const warm = await read($, warmAtom)
  if (!warm.deadline) return
  const cacheAt = await read($, cacheAtom)
  const work = await read($, workAtom)
  const now = await $.clock.now()
  const isWorking = work.startedAt > 0 && !work.endedAt
  // A turn keeps the cache warm itself; a request since the timer was set moves the next ping on.
  const switched = await read($, switchAtom)
  if (isPinging || now >= warm.deadline || isWorking || !cacheAt || isColdAt(cacheAt, now) || warm.waiting || switched || now - cacheAt < warm.every - 1000) return arm($)
  // A host that slept past a retry's slot does not send it in the cache's last minute.
  if (warm.retries && now >= cacheAt + cacheLife - MIN_PING_MS) return stopWarm($, retryReason + afterRetries(warm.retries))
  const sentFor = generation
  isPinging = true
  // Claude Code's cost before the ping, so what the ping cost is read off its own ledger.
  const usdBefore = await ledgerUsd($)
  let reply: Awaited<ReturnType<EngineInterface['model']['fork']>> | { failed: string }
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    reply = { failed: error instanceof Error ? error.message : String(error) }
  } finally {
    isPinging = false
  }
  const at = await $.clock.now()
  // A stop, a /clear or a resume while the ping was out replaced what it was sent for, and a
  // request meanwhile moved the cache clock: either way the reply says nothing now.
  if (sentFor !== generation || (await read($, cacheAtom)) !== cacheAt) return pending ? undefined : arm($)
  if (!reply || 'failed' in reply) return stopWarm($, `the ping failed${reply && 'failed' in reply ? `: ${reply.failed}` : ''}`)
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    // A restarted process has nothing to fork until its first turn; the window waits for one.
    if (!warm.waiting) log($, 'taskband: keepwarm is on, but there is nothing to fork until your next message, so the pings start after it.')
    await update($, warmAtom, old => ({ ...old, waiting: true }))
    return arm($)
  }
  if (!reply.isAnswered && reply.reason === 'api-error') {
    const reason = `the API turned the ping away${reply.status === null ? '' : ` (${reply.status})`}`
    const isBusy = reply.status === null || reply.status === 429 || reply.status >= 500
    const wait = MIN_PING_MS * 2 ** warm.retries
    if (isBusy && warm.retries < MAX_RETRIES && at + wait < Math.min(warm.deadline, cacheAt + cacheLife - MIN_PING_MS)) {
      retryReason = reason
      await update($, warmAtom, old => ({ ...old, retries: old.retries + 1 }))
      disarm()
      pending = $.clock.after(wait, () => void ping($).catch(noop))
      await showWarm($)
      return
    }
    return stopWarm($, reason + afterRetries(warm.retries))
  }
  if (!reply.isAnswered && reply.reason === 'aborted') return stopWarm($, 'the ping was interrupted')
  // An answer, or a reply with no words, still read the cache: its usage says how warm it was.
  const used = reply.usage
  const served = used.cache_read_input_tokens || 0
  const written = used.cache_creation_input_tokens || 0
  const model = await readModel($)
  // What the ping cost by Claude Code's ledger; where that did not move, the table's figure sized to it.
  const usdAfter = usdBefore >= 0 ? await ledgerUsd($) : -1
  const creds = usdAfter > usdBefore && usdBefore >= 0 ? (usdAfter - usdBefore) / DOLLARS_PER_CRED : weigh({ ...used, model })
  const last = { at: now, read: served, creds }
  if (served <= 0 || written >= 0.1 * served) {
    await update($, warmAtom, old => ({ ...old, last }))
    return stopWarm($, `the ping read ${tokens(served)} and wrote ${tokens(written)} tokens, so the cache had already gone cold`)
  }
  // The ping refreshed the cache when it went out.
  await update($, cacheAtom, () => now)
  await saveCache($)
  await update($, warmAtom, old => ({ ...old, last, retries: 0, waiting: false }))
  await arm($)
}

async function readModel($: EngineInterface) {
  const known = await read($, modelAtom)
  if (known) return known
  try {
    return await $.session.model()
  } catch {
    return ''
  }
}

/** Where keepwarm stands, for /keepwarm status. */
async function warmStatus($: EngineInterface) {
  const warm = await read($, warmAtom)
  const cacheAt = await read($, cacheAtom)
  const now = await $.clock.now()
  const always = warm.always ? ` (always, ${duration(warm.always)} after each turn)` : ''
  if (warm.stopped) return `keepwarm stopped: ${warm.stopped}. /keepwarm arms it again.`
  if (!warm.deadline || now >= warm.deadline) return warm.always ? `keepwarm is off until the next turn, which keeps the cache warm for ${duration(warm.always)} (always)` : 'keepwarm is off'
  const next = !cacheAt
    ? 'the first ping comes after the first turn'
    : isColdAt(cacheAt, now)
      ? 'the cache is cold now, so the first ping comes after the next turn'
      : warm.waiting
        ? 'nothing to fork yet, so the first ping comes after the next turn'
        : warm.retries
          ? `the API is busy, ping retry ${warm.retries} of ${MAX_RETRIES}`
          : `next ping in ${countdown(cacheAt + warm.every - now)}`
  const last = warm.last ? ` · last ping read ${tokens(warm.last.read)} tokens for ${tokens(warm.last.creds)} creds (${dollars(warm.last.creds * DOLLARS_PER_CRED)})` : ''
  return `keepwarm ${countdown(warm.deadline - now)} left${always} · ${next}${last}`
}

/** The answer to arming a window: how long, how often, and what each ping and a cold send cost. */
async function armedText($: EngineInterface, length: number) {
  const warm = await read($, warmAtom)
  const context = await read($, contextAtom)
  const model = await readModel($)
  const cacheAt = await read($, cacheAtom)
  const size = context && context.tokens > 0 ? context.tokens : 0
  const sendModel = (await read($, switchAtom))?.to || model
  const prefix = prefixFor(await read($, prefixesAtom), sendModel)
  const costs = size ? ` A ping costs about ${tokens(warmCreds(model, size))} creds; a cold send would cost about ${tokens(coldCreds(sendModel, size, prefix))}.` : ''
  const cold = isColdAt(cacheAt, await $.clock.now()) ? ' The cache is cold now, so the first ping comes after the next turn.' : ''
  return `keepwarm on for ${duration(length)}: after ${duration(warm.every)} idle, one ping re-reads the cache instead of a send rewriting it.${costs}${cold}`
}

/** /keepwarm, word for word as cache-tax takes it. */
async function keepwarmCommand($: EngineInterface, args: string): Promise<string> {
  await seat($)
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words[0] === 'off' && words.length === 1) {
    const wasAlways = (await read($, warmAtom)).always > 0
    await stopWarm($, '', true)
    return wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off'
  }
  if (words[0] === 'status' && words.length === 1) return warmStatus($)
  if (!hasHourCache()) return 'keepwarm needs the one-hour cache. With the band\'s cache lifetime at 5 minutes, a ping every few minutes would cost more than the rewrite it saves within two hours.'
  if (words[0] === 'always') {
    const length = words.length === 1 ? DEFAULT_WINDOW_MS : words.length === 2 ? parseDuration(words[1]) : null
    if (length === null || length < HOUR_MS || length > MAX_WINDOW_MS) return 'always takes one window from 1h to 168h, such as always 24h'
    await update($, warmAtom, warm => ({ ...warm, always: length }))
    await storeSet($, KEY_ALWAYS, length)
    await startWarm($, length, PING_AFTER_MS)
    return `keepwarm always on: every session stays warm until ${duration(length)} after its last turn. /keepwarm off turns it off for good.`
  }
  if (!words.length) {
    await startWarm($, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    return armedText($, DEFAULT_WINDOW_MS)
  }
  const length = parseDuration(words[0])
  if (!length || length > MAX_WINDOW_MS) return 'keepwarm takes a window such as 6h or 90m (up to 168h), or always, off or status'
  let every = PING_AFTER_MS
  if (words.length > 1) {
    // "every 2m" is a testing knob, kept only for the window it came with.
    const period = words[1] === 'every' && words.length === 3 ? parseDuration(words[2]) : null
    if (period === null || period < MIN_PING_MS || period >= cacheLife) return 'every takes a period from 1m to 59m, such as 6h every 2m'
    every = period
  }
  await startWarm($, length, every)
  return armedText($, length)
}

// ---- Remembering the cache across a restart ----
//
// The band's cache clock lives in the session's state, which a restart of the app empties. So at
// the end of every turn, and after every ping, it keeps when the cache was last refreshed, over how
// much context and on which model, under the chat's id. A chat opened again finds its clock where
// it was, and the band can say, before anything is sent, that the cache went cold and what the
// next send costs. A chat with history that the band never saw says the cache is unknown, and what
// a send would cost if it is cold.

const KEY_CACHE = 'cache:'
/** A chat untouched this long is forgotten. */
const KEEP_CACHE_MS = 30 * 24 * HOUR_MS
type KeptCache = { at: number; tokens: number; window: number; model: string }
const isKeptCache = (value: unknown): value is KeptCache => !!value && typeof value === 'object' && typeof (value as KeptCache).at === 'number'
/** The chat had prompts before this process began: reopened, or restarted with the app. */
let hasHistory = false

async function saveCache($: EngineInterface) {
  if (!sessionKey) return
  const at = await read($, cacheAtom)
  if (!at) return
  const context = await read($, contextAtom)
  const kept: KeptCache = { at, tokens: context?.tokens ?? -1, window: context?.window ?? 0, model: await read($, modelAtom) }
  await storeSet($, KEY_CACHE + sessionKey, kept)
}

async function restoreCache($: EngineInterface, now: number) {
  hasHistory = (await $.session.turns().catch(() => 0)) > 0
  const kept = sessionKey ? await storeGet($, KEY_CACHE + sessionKey) : undefined
  if (isKeptCache(kept) && kept.at <= now) {
    await update($, cacheAtom, at => (at >= kept.at ? at : kept.at))
    if (kept.tokens > 0 && kept.window > 0) {
      await update($, contextAtom, context => (context && context.tokens > 0 ? context : { tokens: kept.tokens, window: context?.window || kept.window, compactAt: context?.compactAt || compactTokens }))
    }
    if (kept.model) await update($, modelAtom, model => model || kept.model)
  }
  const prefixes = await storeGet($, KEY_PREFIXES)
  if (prefixes && typeof prefixes === 'object') {
    const valid = Object.fromEntries(Object.entries(prefixes as Record<string, unknown>).filter((one): one is [string, number] => typeof one[1] === 'number' && one[1] >= 0))
    // The store holds every chat's latest measurement, this one's included.
    await update($, prefixesAtom, old => ({ ...old, ...valid }))
  }
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(KEY_CACHE)) continue
      const one = await storeGet($, key)
      if (!isKeptCache(one) || now - one.at > KEEP_CACHE_MS) await storeDelete($, key)
    }
  } catch {
    // Pruning waits for the next start.
  }
}

/** At the start of a session or a reload: the cache clock, the window this session armed, the always switch, and the model. */
async function startKeepwarm($: EngineInterface, now: number) {
  try {
    sessionKey = await $.session.id()
  } catch {
    sessionKey = ''
  }
  const model = await $.session.model().catch(() => '')
  if (model) await update($, modelAtom, () => model)
  await restoreCache($, now)
  const saved = sessionKey ? await storeGet($, KEY_DEADLINE + sessionKey) : undefined
  const savedEvery = sessionKey ? await storeGet($, KEY_EVERY + sessionKey) : undefined
  const always = alwaysOf(await storeGet($, KEY_ALWAYS))
  // A reload keeps the window in the band's state; a restart finds it in the store.
  const warm = await update($, warmAtom, old => {
    if (old.deadline > now) return { ...old, always, retries: 0 }
    const deadline = typeof saved === 'number' && saved > now ? saved : 0
    const every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < HOUR_MS ? savedEvery : PING_AFTER_MS
    return { ...old, deadline, every, always, retries: 0 }
  })
  if (always && hasHourCache()) await startWarm($, Math.max(always, warm.deadline - now), PING_AFTER_MS)
  else await arm($)
}

/** After a turn: always renews its window, and a turn that paid for a cold cache arms three hours. */
async function warmAfterTurn($: EngineInterface, isAborted: boolean) {
  await seat($)
  await saveCache($)
  const now = await $.clock.now()
  // Another session may have changed the always switch.
  const always = alwaysOf(await storeGet($, KEY_ALWAYS))
  const warm = await update($, warmAtom, old => ({ ...old, always, waiting: false }))
  const wasCold = isColdTurn
  isColdTurn = false
  if (!hasHourCache() || isAborted) return arm($)
  if (always) return startWarm($, Math.max(always, warm.deadline - now), PING_AFTER_MS)
  if (wasCold && isAutoWarm && warm.deadline < now + AUTO_WARM_MS) {
    await startWarm($, AUTO_WARM_MS, warm.deadline > now ? warm.every : PING_AFTER_MS)
    log($, `taskband: that send wrote the cold cache again. Keepwarm holds it warm for ${duration(AUTO_WARM_MS)} so the next break does not pay that twice; /keepwarm off stops it.`)
    return
  }
  await arm($)
}

export const register: Register = (on, options) => {
  const settings = (options ?? {}) as Record<string, unknown>
  cacheLife = (Number(settings.cacheMinutes ?? 60) === 5 ? 5 : 60) * 60_000
  // The cooling notice is off unless turned on; the red, pulsing countdown shows either way.
  isCacheAlertOn = settings.cacheAlert === 'on'
  isSoundOn = settings.finishSound !== 'off'
  isAutoWarm = settings.autoWarm !== 'off'

  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage().catch(() => undefined)
    await keepLimits($, usage?.rateLimits)
    await keepContext($, usage?.context)
    // A turn cut off by a restart is not still running, and a compaction it left half done is over.
    const now = await $.clock.now()
    await update($, workAtom, work => (work.startedAt && !work.endedAt ? { ...work, endedAt: now } : work))
    await update($, viewAtom, view => (view.compact === 'idle' ? view : { ...view, compact: 'idle' }))
    await update($, nowAtom, () => now)
    ticking ??= $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })
    fastTicking ??= $.clock.every(FAST_MS, () => {
      void fastTick($).catch(() => undefined)
    })
    // Where auto-compaction runs is read once, after start: a local estimate, no request is sent.
    $.clock.after(0, () => {
      void (async () => {
        const detail = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
        const breakdown = detail?.context.breakdown
        compactTokens = breakdown?.isAutoCompactEnabled && breakdown.autoCompactThreshold ? breakdown.autoCompactThreshold : 0
        if (compactTokens) await update($, contextAtom, context => (context ? { ...context, compactAt: compactTokens } : context))
      })().catch(() => undefined)
    })
    await startKeepwarm($, now).catch(noop)
    await $.command
      .register({
        name: 'keepwarm',
        description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always (or always 24h), off, or status (taskband)',
        argumentHint: '[6h | 90m | 6h every 2m | always [24h] | off | status]',
        immediate: true,
      })
      .catch(noop)
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => ({ text: await keepwarmCommand($, String((e as { args?: unknown }).args ?? '')) }))

  // /clear starts a new conversation: the window armed for the old one ends, and always arms the
  // new one at its first turn. A resume carries the window on, under the new id.
  on('session.end', async ($, e, next) => {
    // /clear empties the fill into a new chat; a resume loads another chat, whose empty fill is no one's doing.
    if (e.reason === 'clear') {
      isCleared = true
      isEmptying = true
    } else if (e.reason === 'resume') {
      liveTokens = 0
      isEmptying = false
      isCleared = false
    }
    try {
      if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === sessionKey) {
        generation += 1
        disarm()
        await saveWindow($, NO_WARM)
        sessionKey = ''
        if (e.reason === 'clear') await update($, warmAtom, warm => ({ ...warm, deadline: 0, every: PING_AFTER_MS, stopped: '', retries: 0, waiting: true }))
        else await update($, warmAtom, warm => ({ ...warm, waiting: true }))
      }
      // The next chat's cache is its own, whichever model the last one switched to.
      if (e.reason === 'clear' || e.reason === 'resume') await update($, switchAtom, () => null)
    } catch {
      // Keepwarm stays as it was.
    }
    return next(e)
  })

  // A model switch: none of the chat is cached on the new model, so the next send writes it there
  // at that model's prices, and keepwarm holds its pings until that send. Switching back before a
  // send finds the cache where it was. A resume brings its own chat's model and is no switch.
  // Where an organization keeps this event from installed plugins, the band's tick asks for the
  // model between turns and sees the switch that way.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.source !== 'resume') await noteModel($, e.to_model, e.from_model)
    } catch {
      // The tick sees the switch.
    }
    return result
  }).catch(($, e, next) => next(e))

  // A compaction leaves a summary where the chat was: the old cache serves nothing, so the pings
  // wait for the first request over the new one, and the band counts the new size once the
  // summary is in place. One computed ahead of time installs nothing.
  // Where an organization manages Claude Code this event passes over installed plugins, and the
  // band's tick sees the compaction by the fill it empties.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && (result as { messages?: unknown }).messages) {
      isEmptying = true
      await afterCompaction($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A typed prompt starts new work. An unfinished to-do list carries over; a finished one is cleared.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const cacheAt = await read($, cacheAtom)
      const now = await touchCache($)
      // A send into a cold cache writes the context again: auto keepwarm arms after it. The send
      // after a compaction writes only the summary, and follows no break. Either one's first
      // request reads back how much of the prompt stayed cached all the same, as does the first
      // on a model switched to.
      const context = await read($, contextAtom)
      if (isColdAt(cacheAt, now) && cacheAt !== compactedCacheAt && context && context.tokens >= BIG_CONTEXT) isColdTurn = true
      isMeasuringPrefix = isColdAt(cacheAt, now) || !!(await read($, switchAtom))
      if (e.text.trim()) {
        const usage = await $.session.usage().catch(() => undefined)
        const cost = typeof usage?.cost?.usd === 'number' ? usage.cost.usd : -1
        // Both limits as the turn begins. A reading whose window has since reset stands for an
        // empty window, not dated yet, so the turn is not charged for what the old one held.
        const startOf = (one: Limit | null): Limit | null => (one && one.resetsAt > 0 && one.resetsAt <= now ? { percentUsed: 0, resetsAt: 0 } : one)
        const fiveFrom = startOf(limitOf(usage?.rateLimits, 'five_hour') ?? (await read($, limitAtom)))
        const weekFrom = startOf(limitOf(usage?.rateLimits, 'seven_day') ?? (await read($, weekAtom)))
        await update($, useAtom, () => ({ ...NO_USE, costFrom: cost, cost, fiveFrom, weekFrom }))
        await update($, workAtom, work => ({ startedAt: now, endedAt: 0, tools: 0, steps: work.steps.every(step => step.status === 'completed') ? [] : work.steps }))
      } else {
        await update($, workAtom, work => ({ ...work, startedAt: work.startedAt || now, endedAt: 0 }))
      }
      await update($, nowAtom, () => now)
    }
    return next(e)
  })

  // Every model request of the prompt, its subagents' included, adds what it used, weighted by
  // the prices of the model that answered, to the prompt and to each limit's window.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      // A keepwarm ping between turns is no turn's work.
      const work = await read($, workAtom)
      if (isPinging && !(work.startedAt > 0 && !work.endedAt)) return response
      const used = response?.usage
      // The model the main thread asks prices a cold send.
      const asked = e as { agentId?: string; model?: string }
      const model = asked.agentId ? '' : used?.model || asked.model || ''
      if (model && model !== (await read($, modelAtom))) await update($, modelAtom, () => model)
      if (used && isMeasuringPrefix && !asked.agentId) {
        isMeasuringPrefix = false
        await measurePrefix($, used, model)
      }
      // The main thread has sent on the model switched to, so the cache is on it now.
      if (!asked.agentId && (await read($, switchAtom))) await update($, switchAtom, () => null)
      if (used) {
        const weighted = weigh(used)
        await update($, useAtom, use => ({
          ...use,
          input: use.input + (used.input_tokens || 0),
          output: use.output + (used.output_tokens || 0),
          cacheRead: use.cacheRead + (used.cache_read_input_tokens || 0),
          cacheWrite: use.cacheWrite + (used.cache_creation_input_tokens || 0),
          weighted: use.weighted + weighted,
        }))
      }
    } catch {
      // The band misses one request; the request itself is untouched.
    }
    return response
  })

  // Every tool call is counted, and the list tools move the steps. A call also means a request
  // has just been answered, so the cache is fresh.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const call = e as unknown as Record<string, unknown> & { tool: string; agentId?: string }
      const isMain = !call.agentId
      const now = isMain ? await touchCache($) : await $.clock.now()
      const isDenied = (ran as { deny?: unknown }).deny !== undefined
      await update($, workAtom, work => {
        const steps = isMain && !isDenied && PLAN_TOOLS.has(call.tool) ? stepsAfter(work.steps, call.tool, call, (ran as { result?: unknown }).result) : undefined
        return { ...work, tools: work.tools + 1, steps: steps ? timeSteps(work.steps, steps, now) : work.steps }
      })
    } catch {
      // The band misses one call; the call itself is untouched.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = e as { agentId?: string; durationMs?: number; isAborted?: boolean }
    let isEmptied = false
    if (done.agentId === undefined) {
      isMeasuringPrefix = false
      const usage = await $.session.usage().catch(() => undefined)
      // A turn that leaves the fill empty, as /compact run as a prompt does, left nothing the cache keeps.
      isEmptied = !!usage?.context.window && typeof usage.context.tokens !== 'number'
      const now = isEmptied ? await $.clock.now() : await touchCache($)
      await update($, workAtom, work => (work.startedAt ? { ...work, endedAt: now } : work))
      await update($, nowAtom, () => now)
      // A long turn rings when it ends, so the person can look away while Claude works.
      if (isSoundOn && !done.isAborted && (done.durationMs ?? 0) >= LONG_TURN_MS) {
        $.clock.after(0, () => {
          void ring($)
        })
      }
      // The turn's cost as it ends: later the ledger moves only by keepwarm's pings.
      const usd = usage?.cost?.usd
      if (typeof usd === 'number') await update($, useAtom, use => (use.costFrom >= 0 && usd > use.cost ? { ...use, cost: usd } : use))
    }
    const result = await next(e)
    if (done.agentId === undefined) {
      await warmAfterTurn($, !!done.isAborted).catch(noop)
      if (isEmptied) await fillGone($).catch(noop)
    }
    return result
  })

  // The engine reports the limits, the context fill and the cost whenever they move.
  on('session.measure', async ($, e, next) => {
    const usd = e.cost?.usd
    // The cost counts toward the turn while it runs; between turns only keepwarm's pings move it.
    const work = await read($, workAtom)
    const isWorking = work.startedAt > 0 && !work.endedAt
    if (typeof usd === 'number' && isWorking) await update($, useAtom, use => ({ ...use, cost: usd, costFrom: use.costFrom < 0 ? usd : use.costFrom }))
    const before = { five: await read($, limitAtom), week: await read($, weekAtom) }
    await keepLimits($, e.rateLimits)
    await keepContext($, e.context)
    const five = limitOf(e.rateLimits, 'five_hour')
    const seven = limitOf(e.rateLimits, 'seven_day')
    if (five || seven) {
      // A turn that began with no reading starts from the first one it gets; one whose window
      // turned over carries what it took of the old window.
      await update($, useAtom, use => {
        const [fiveFrom, fiveCarried] = rebase(use.fiveFrom ?? five, use.fiveCarried, before.five, five)
        const [weekFrom, weekCarried] = rebase(use.weekFrom ?? seven, use.weekCarried, before.week, seven)
        const isSame = fiveFrom === use.fiveFrom && weekFrom === use.weekFrom && fiveCarried === use.fiveCarried && weekCarried === use.weekCarried
        return isSame ? use : { ...use, fiveFrom, fiveCarried, weekFrom, weekCarried }
      })
    }
    return next(e)
  })

  drawing(on)
}

// ---- Drawing ----

// The look follows shadcn/ui: quiet muted labels, figures in a heavier weight with even digits,
// full-round progress pills, and the details in one rounded card with a grid of stat blocks.

function drawing(on: Parameters<Register>[0]) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The progress pill is a picture everywhere but the terminal, which draws it in text.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const work = await read($, workAtom)
    const limit = await read($, limitAtom)
    const week = await read($, weekAtom)
    const use = await read($, useAtom)
    const context = await read($, contextAtom)
    const view = await read($, viewAtom)
    const cacheAt = await read($, cacheAtom)
    const model = await read($, modelAtom)
    const prefixes = await read($, prefixesAtom)
    const switched = await read($, switchAtom)
    const now = Math.max(await read($, nowAtom), work.startedAt, work.endedAt, cacheAt)
    const columns = Math.max(40, e.props.bodyColumns)
    // On a narrow window the band drops its quiet extras before anything gets cut.
    const isNarrow = columns < 90
    // Motion is set against the clock as it reads now, not the last tick's time.
    const at = await $.clock.now()

    // ---- Small parts ----

    // A piece that keeps its own width and never wraps.
    const fixed = (key: string, child: unknown) => (
      <Box key={key} flexShrink={0}>
        {child as never}
      </Box>
    )
    // A thin full-round track with its filled part, as shadcn's Progress draws it. In the band's row
    // its fill slides to a new length and a shimmer crosses it while Claude works (`shimmer`); in the
    // details it holds still (`still`). `id` names a bar whose key another bar shares.
    const bar = (key: string, share: number, tone: Tone, width: number, says: string, moves: { id?: string; shimmer?: boolean; still?: boolean } = {}) => {
      const part = Math.max(0, Math.min(1, share))
      if (Svg && moves.still) return fixed(key, <Svg source={pill(part, HEX[tone], width)} alt={says} width={width} height={PILL_HEIGHT} />)
      if (Svg) {
        const where = `${e.surface}:${moves.id ?? key}:${width}`
        const hex = HEX[tone]
        const slide = slideTo(where, part, at)
        const into = at - slide.at
        const isMoving = into < SLIDE_MS && slide.from !== slide.to
        // Kept as built while it shows the same: a redraw neither restarts the slide nor the shimmer.
        const source = steady(where, `${part}|${hex}|${isMoving ? slide.at : 'still'}|${moves.shimmer ? 'shimmer' : ''}`, at, () => ({
          source: pill(part, hex, width, { from: isMoving ? slide.from : part, into: isMoving ? into : 0, ...(moves.shimmer ? { shimmer: phaseAt(at, SHIMMER_MS) } : {}) }),
          until: isMoving ? slide.at + SLIDE_MS : 0,
        }))
        return fixed(key, <Svg source={source} alt={says} width={width} height={PILL_HEIGHT} />)
      }
      const cells = Math.max(4, Math.round(width / 12))
      const filled = Math.round(part * cells)
      return fixed(
        key,
        <Text>
          <Text color={tone}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(cells - filled)}</Text>
        </Text>,
      )
    }
    // A figure: a step larger, semibold, even digits.
    const figure = (key: string, text: string, color?: string) =>
      fixed(
        key,
        <Text size="heading" weight="semibold" tabular color={color} wrap="truncate">
          {text}
        </Text>,
      )
    // A muted word beside a figure.
    const muted = (key: string, text: string) =>
      fixed(
        key,
        <Text dimColor tabular wrap="truncate">
          {text}
        </Text>,
      )
    // A small muted line under a figure, in the details.
    const note = (key: string, text: string) => (
      <Text key={key} size="footnote" dimColor tabular wrap="wrap">
        {text}
      </Text>
    )
    const separator = (key: string) => muted(key, '│')

    // ---- 1. The work on the latest prompt ----
    const isWorking = work.startedAt > 0 && !work.endedAt
    const total = work.steps.length
    const done = work.steps.filter(step => step.status === 'completed').length
    const running = work.steps.find(step => step.status === 'in_progress')
    const took = work.startedAt ? span((work.endedAt || now) - work.startedAt) : ''
    // What the turn used, in creds: its cost in tokens of Opus 5.5 input, from Claude Code's ledger
    // where there is one, else from the band's price table. They follow the cost, not the re-reads.
    // The raw tokens every request read, wrote and sent back go before the limits in the details.
    const hasLedger = use.cost >= 0 && use.costFrom >= 0
    const used = hasLedger ? Math.max(0, use.cost - use.costFrom) / DOLLARS_PER_CRED : use.weighted
    const raw = use.input + use.output + use.cacheRead + use.cacheWrite
    const isAllDone = total > 0 && done === total
    // A turn that ended with steps left says how far it got, not that something went wrong.
    const headline = !work.startedAt
      ? 'Waiting for a prompt'
      : total
        ? isAllDone
          ? 'All tasks done'
          : !isWorking
            ? 'Turn ended'
            : running
              ? running.active || running.text
              : 'Working'
        : isWorking
          ? 'Working'
          : 'All tasks done'
    const taskTone: Tone = isAllDone || (!total && work.startedAt && !isWorking) ? GOOD : ACCENT
    const glyph = !work.startedAt ? '○' : isAllDone || (!total && !isWorking) ? '✓' : isWorking ? '●' : '○'

    // The title takes the room that is left, but never less than a short word or two;
    // the time and tokens beside it give way first.
    const title = (
      <Box key="h" flexShrink={1} minWidth={Math.min(headline.length, 16)} overflow="hidden">
        <Text size="heading" weight="semibold" dimColor={!work.startedAt} wrap="truncate-end">
          {clip(headline, 80)}
        </Text>
      </Box>
    )
    const stats = took ? (
      <Box key="d" flexShrink={8} minWidth={0} overflow="hidden">
        <Text dimColor tabular wrap="truncate-end">
          {used ? `${took} · ${tokens(used)} creds` : took}
        </Text>
      </Box>
    ) : null
    const task = [
      fixed('m', <Text color={work.startedAt ? taskTone : undefined} dimColor={!work.startedAt} weight="semibold">{glyph}</Text>),
      title,
      total ? bar('b', done / total, taskTone, isNarrow ? 48 : 64, `${done} of ${total} steps done`, { id: 'task', shimmer: isWorking && !isAllDone }) : null,
      total ? figure('n', `${done}/${total}`) : null,
      isNarrow ? null : stats,
    ]

    // ---- 2. The 5-hour limit ----
    const percentOf = (one: Limit | null) => (one && !(one.resetsAt > 0 && now >= one.resetsAt) ? one.percentUsed : 0)
    const limitToneOf = (percent: number): Tone => (percent >= 90 ? BAD : percent >= 70 ? WARN : ACCENT)
    const isResetOf = (one: Limit | null) => !!one && one.resetsAt > 0 && now >= one.resetsAt
    const fiveUsed = percentOf(limit)
    const limitTone = limitToneOf(fiveUsed)
    const limitPart = !limit
      ? [muted('l', '5h'), muted('v', 'no reading yet')]
      : isResetOf(limit)
        ? [muted('l', '5h'), figure('v', 'reset', GOOD)]
        : [
            muted('l', '5h'),
            bar('b', fiveUsed / 100, limitTone, isNarrow ? 36 : 48, `${Math.round(fiveUsed)}% of the 5-hour limit used`, { id: 'five' }),
            figure('v', `${Math.round(fiveUsed)}%`, fiveUsed >= 70 ? limitTone : undefined),
          ]

    // ---- 3. The prompt cache. In its last five minutes it turns red and its dot pulses. ----
    // Once cold it says what the next send costs to write the context again, before it is sent:
    // the head of the prompt that stays cached anyway is priced as a read. After a model switch
    // the next send writes it on the new model, at that model's prices, whatever the clock says.
    // Keepwarm's window is on its own status line below, beside the model picker.
    const left = cacheAt ? cacheAt + cacheLife - now : 0
    const isCooling = left > 0 && left <= WARN_MS
    const isBeat = Math.floor(now / FAST_MS) % 2 === 0
    const sendModel = switched?.to || model
    const coldCost = context && context.tokens > 0 ? coldCreds(sendModel, context.tokens, prefixFor(prefixes, sendModel)) : 0
    // The cost of a cold send stands out by its size: amber from 100k creds ($0.40), red from 300k ($1.20).
    const coldTone = coldCost >= COSTLY_SEND ? BAD : coldCost >= DEAR_SEND ? WARN : undefined
    const coldFigure = (key: string, text: string) =>
      fixed(
        key,
        <Text color={coldTone} dimColor={!coldTone} tabular wrap="truncate">
          {text}
        </Text>,
      )
    const nextSend = coldCost ? coldFigure('x', isNarrow ? `≈${tokens(coldCost)}` : `next send ≈${tokens(coldCost)} creds`) : null
    // On the desktop a small clock before the word carries the app's own tooltip: when the cache
    // goes cold and what a send after that costs. Its words name fixed moments, not a countdown,
    // so the picture stays the same from one redraw to the next.
    const cacheTip = !cacheAt
      ? ''
      : switched
        ? `nothing of this chat cached on ${modelName(switched.to)}${left > 0 ? ` · on ${modelName(switched.from)} it stays warm until ${clockTime(cacheAt + cacheLife, now)}` : ''}`
        : left > 0
          ? `goes cold ${clockTime(cacheAt + cacheLife, now)}${coldCost ? ` · a send after that ≈${tokens(coldCost)} creds` : ''}`
          : `cold since ${clockTime(cacheAt + cacheLife, now)}`
    // Its ring is the cache itself, draining smoothly on its own over the cache's life. The picture is
    // built again only when the cache is refreshed or its words change, and now and then while it
    // drains (a twentieth of the life, a minute at most), so one drawn afresh is never far off.
    const isDraining = !!cacheAt && !switched && cacheAt + cacheLife > at
    const clockSource = () =>
      steady(`${e.surface}:clock`, `${cacheTip}|${cacheAt}|${cacheLife}|${isDraining}`, at, () => ({
        source: clockIcon(cacheTip, isDraining ? { life: cacheLife, elapsed: at - cacheAt, warnIn: cacheAt + cacheLife - WARN_MS - at, red: HEX[BAD] } : undefined),
        until: isDraining ? at + Math.min(REBUILD_MS, cacheLife / 20) : 0,
      }))
    const tipClock =
      e.surface === 'desktop' && Svg && cacheTip
        ? fixed('i', <Svg source={clockSource()} alt={cacheTip} width={CLOCK_SIZE} height={CLOCK_SIZE} isInteractive />)
        : null
    // In the cache's last minutes a red dot fades down and back up; the terminal, with no pictures,
    // blinks it with each second's redraw instead.
    const coolingDot = Svg ? (
      <Svg source={steady(`${e.surface}:dot`, HEX[BAD], at, () => ({ source: dotIcon(HEX[BAD], at), until: 0 }))} alt="the cache is in its last five minutes" width={8} height={8} />
    ) : (
      <Text color={isBeat ? BAD : undefined} dimColor={!isBeat}>
        ●
      </Text>
    )
    // A chat with history whose cache the band never saw refreshed: what a send costs if it is cold.
    const isUnknown = !cacheAt && hasHistory && coldCost > 0
    const cachePart = isUnknown
      ? [muted('l', 'cache'), muted('v', 'unknown'), coldFigure('x', isNarrow ? `≈${tokens(coldCost)}` : `if cold ≈${tokens(coldCost)} creds`)]
      : !cacheAt
      ? [muted('l', 'cache'), muted('v', 'not started')]
      : left <= 0 || switched
        ? [tipClock, muted('l', 'cache'), figure('v', 'cold', BAD), nextSend]
        : [
            tipClock,
            isCooling ? fixed('p', coolingDot) : null,
            muted('l', 'cache'),
            figure('v', cacheCountdown(left), isCooling ? BAD : undefined),
          ]

    const group = (key: string, body: unknown, grows = false) => (
      <Box
        key={key}
        flexDirection="row"
        alignItems="center"
        columnGap={1}
        flexShrink={grows ? 1 : 0}
        flexGrow={grows ? 1 : 0}
        minWidth={grows ? 0 : undefined}
        overflow={grows ? 'hidden' : 'visible'}
      >
        {body as never}
      </Box>
    )

    // The chevron, a ghost icon button: dim at rest, full under the pointer. The glyph is its
    // label, since a desktop draws a button's label rather than its children.
    const toggle = (
      <Button
        key="more"
        plain
        dimColor
        label={view.isOpen ? '▴' : '▾'}
        onPress={() => update($, viewAtom, old => ({ isOpen: !old.isOpen, compact: old.compact === 'running' ? 'running' : 'idle', isWarmAsking: false }))}
      />
    )

    // One line as wide as the band, never wider. The task sits at the left and takes the room
    // that is left, giving way first; the limit, the cache and the toggle keep their width and
    // sit against the right edge.
    const row = (
      <Box key="row" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
        {group('task', task, true)}
        <Box key="right" flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
          {separator('s1')}
          {group('limit', limitPart)}
          {separator('s2')}
          {group('cache', cachePart)}
          {fixed('t', toggle)}
        </Box>
      </Box>
    )
    if (!view.isOpen)
      return (
        <Box flexDirection="column" paddingX={1}>
          {row}
        </Box>
      )

    // ---- The details: one rounded card, every step in it ----

    // The band never grows past `maxRows`; a taller tree scrolls. Every step is always listed, and
    // the card picks the fullest layout that shows it all whole: labels above the figures in a
    // bordered card, then labels beside them, then no border. When none does, it keeps the fullest
    // one and the band scrolls.
    const inner = columns - 2 - 2 - 4
    const across = inner >= 124 ? 4 : inner >= 60 ? 2 : 1
    const GAP = 3
    const blockWidth = Math.floor((inner - GAP * (across - 1)) / across)
    const blockLines = Math.ceil(4 / across)
    type Layout = { framed: boolean; stacked: boolean }
    const LAYOUTS: Layout[] = [
      { framed: true, stacked: true },
      { framed: true, stacked: false },
      { framed: false, stacked: false },
    ]
    // Rows besides the steps: the main row, the border, the gap under the steps, the grid.
    const rowsAround = (layout: Layout) =>
      1 + (layout.framed ? 2 + (total ? 1 : 0) + (blockLines - 1) : 0) + blockLines * (layout.stacked ? 3 : 2)
    // One row is kept spare, so a figure set a size larger never tips the band into scrolling.
    const room = Math.max(1, e.props.maxRows - 1)
    const layout = LAYOUTS.find(one => room - rowsAround(one) >= total) ?? LAYOUTS[0]!
    const pillWidth = layout.stacked ? Math.max(56, Math.min(160, blockWidth * 4)) : Math.max(48, Math.min(120, blockWidth * 3))

    // While Compact asks, Yes and No take the button's place on the Context line, and the question
    // stands over them, right-aligned on the figure line of the block above in the grid: the 7d
    // limit two across, This turn one across. Four across nothing is above, so it goes on the
    // Context label line, or, with the labels beside the figures, just before Yes and No.
    const isAsking = view.compact === 'ask'
    const aboveContext = across === 2 ? 'week' : across === 1 ? 'turn' : ''
    const question = (key: string) => [
      <Box key={`${key}-qs`} flexGrow={1} />,
      fixed(
        `${key}-q`,
        <Text size="footnote" weight="medium">
          Compact now?
        </Text>,
      ),
    ]

    // Keep warm sits at the end of the 7d limit's pill line, as Compact does on the Context line.
    // Pressed, it gives way to its question, and 3h, 6h and Off stand where Compact (or Yes and
    // No) stand. The question and the three buttons are each centred in the room right of their
    // pill: the two lines are built alike, pills of one width in blocks of one width, so the
    // question stands centred over the buttons. While Compact asks on that same line, its
    // question takes the spot instead.
    const isWarmAsking = view.isWarmAsking === true
    const warmControl = () =>
      isWarmAsking
        ? [
            <Box key="week-wq" flexGrow={1} flexDirection="row" justifyContent="center" minWidth={0}>
              <Text size="footnote" weight="medium">
                Keep warm for?
              </Text>
            </Box>,
          ]
        : [
            <Box key="week-ws" flexGrow={1} />,
            fixed(
              'kw',
              <Button
                key="keepwarm"
                label="Keep warm"
                variant="secondary"
                onPress={() => update($, viewAtom, old => ({ ...old, compact: old.compact === 'running' ? 'running' : 'idle', isWarmAsking: true }))}
              />,
            ),
          ]
    const chooseWarm = (args: string) => {
      void (async () => {
        await update($, viewAtom, old => ({ ...old, isWarmAsking: false }))
        const answer = await keepwarmCommand($, args)
        say($, answer.startsWith('keepwarm on for') ? `Keeping the cache warm for ${args}.` : answer)
      })().catch(noop)
    }

    // A stat block: a muted label above its lines, or beside the first one.
    const block = (key: string, label: string, head: unknown[], rest: unknown[]) => {
      const name = (
        <Text key={`${key}-l`} size="footnote" weight="medium" dimColor>
          {label}
        </Text>
      )
      const asksOnHead = isAsking && aboveContext === key
      const asksOnLabel = isAsking && !aboveContext && layout.stacked && key === 'ctx'
      return (
        <Box key={key} flexDirection="column" width={blockWidth} flexShrink={0} rowGap={0}>
          {!layout.stacked ? null : asksOnLabel ? (
            <Box key={`${key}-lr`} flexDirection="row" alignItems="center" columnGap={1}>
              {name}
              {question(key) as never}
            </Box>
          ) : (
            name
          )}
          <Box key={`${key}-h`} flexDirection="row" alignItems="center" columnGap={1}>
            {layout.stacked ? null : fixed(`${key}-n`, name)}
            {head as never}
            {asksOnHead ? (question(key) as never) : key === 'week' ? (warmControl() as never) : null}
          </Box>
          {rest as never}
        </Box>
      )
    }

    // Every step of the task, with how long it took: a running step counts up, a checked-off one
    // keeps its time. A step never seen running has none. The title and the count are on the row
    // above, so they are not repeated.
    const stepRows = work.steps.map((step, i) => {
      const mark = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'
      const tone = step.status === 'completed' ? GOOD : step.status === 'in_progress' ? ACCENT : undefined
      const end = step.status === 'completed' ? step.endedAt : step.status === 'in_progress' ? (isWorking ? now : work.endedAt || now) : undefined
      const took = step.startedAt && end ? span(end - step.startedAt) : ''
      return (
        <Box key={`s${i}`} flexDirection="row" columnGap={1}>
          {fixed(`g${i}`, <Text color={tone} dimColor={step.status === 'pending'}>{mark}</Text>)}
          <Box key={`st${i}`} flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor={step.status !== 'in_progress'} weight={step.status === 'in_progress' ? 'medium' : 'regular'} wrap="truncate-end">
              {step.status === 'in_progress' ? step.active || step.text : step.text}
            </Text>
          </Box>
          {took ? muted(`t${i}`, took) : null}
        </Box>
      )
    })
    const taskSection = total ? (
      <Box key="task" flexDirection="column" rowGap={0}>
        {stepRows}
      </Box>
    ) : null

    // A limit: its share and pill, then when it resets, on the clock and from now.
    const limitBlock = (key: string, label: string, one: Limit | null) => {
      if (!one) return block(key, label, [muted(`${key}f`, 'no reading yet')], [])
      if (isResetOf(one)) return block(key, label, [figure(`${key}f`, 'reset', GOOD)], [note(`${key}n`, 'a fresh window starts with the next message')])
      const percent = percentOf(one)
      const tone = limitToneOf(percent)
      return block(
        key,
        label,
        [figure(`${key}f`, `${Math.round(percent)}%`, percent >= 70 ? tone : undefined), bar(`${key}b`, percent / 100, tone, pillWidth, `${Math.round(percent)}% of the ${label} used`, { still: true })],
        [one.resetsAt ? note(`${key}n`, `resets ${clockTime(one.resetsAt, now)} · in ${countdown(one.resetsAt - now)}`) : null],
      )
    }

    // This prompt: tokens first, then the dollars and calls, then what it took of each limit.
    const cost = use.cost >= 0 && use.costFrom >= 0 ? Math.max(0, use.cost - use.costFrom) : -1
    const calls = `${work.tools} tool call${work.tools === 1 ? '' : 's'}`
    // How far each limit moved this turn: what it took of any window that ended during it, and the
    // rise in the window it is in now. A fall within one window (a new plan) adds nothing.
    const shareOf = (from: Limit | null, to: Limit | null, carried: number) => {
      if (!from || !to) return null
      const isSameWindow = !from.resetsAt || isSameReset(from.resetsAt, to.resetsAt)
      return carried + (isSameWindow ? Math.max(0, to.percentUsed - from.percentUsed) : to.percentUsed)
    }
    const measured = (
      [
        ['5h', shareOf(use.fiveFrom, limit, use.fiveCarried)],
        ['7d', shareOf(use.weekFrom, week, use.weekCarried)],
      ] as const
    )
      .filter(([, share]) => share !== null)
      .map(([name, share]) => `${name} +${share!.toFixed(1)}%`)
      .join(' · ')
    const turnBlock = !work.startedAt
      ? block('turn', 'This turn', [muted('tf', 'nothing yet')], [])
      : block(
          'turn',
          'This turn',
          [figure('tf', tokens(used)), muted('tt', ['creds', cost >= 0 ? dollars(cost) : '', calls].filter(Boolean).join(' · '))],
          // The raw tokens, then how far each limit moved.
          [note('tm', [raw ? `${tokens(raw)} tokens` : '', measured].filter(Boolean).join(' · ') || 'no limit reading yet')],
        )

    // The context window: how full, and where it compacts. Its block is drawn like the other three.
    const hasFill = !!context && context.tokens >= 0
    const fill = hasFill ? Math.round((context!.tokens / context!.window) * 100) : 0
    const compactPercent = context && context.compactAt ? Math.round((context.compactAt / context.window) * 100) : 0
    // Amber within ten points of where Claude Code compacts, red within three; without a known
    // point, at 70% and 85%.
    const fillTone: Tone = compactPercent
      ? fill >= compactPercent - 3
        ? BAD
        : fill >= compactPercent - 10
          ? WARN
          : ACCENT
      : fill >= 85
        ? BAD
        : fill >= 70
          ? WARN
          : ACCENT
    // The Compact button, and in its place, once pressed, Yes and No (the question stands over
    // them, see `question`): the line under the figure never moves.
    const isQuestionInline = isAsking && !aboveContext && !layout.stacked
    const compactSlot =
      view.compact === 'running' ? (
        muted('cr', 'Compacting…')
      ) : isWarmAsking ? (
        // Centred in the room right of the pill, as the question is on its line.
        <Box key="wq" flexDirection="row" alignItems="center" justifyContent="center" columnGap={1} flexGrow={1} flexShrink={0}>
          {fixed('w3', <Button key="keepwarm-3h" label="3h" variant="primary" onPress={() => chooseWarm('3h')} />)}
          {fixed('w6', <Button key="keepwarm-6h" label="6h" variant="secondary" onPress={() => chooseWarm('6h')} />)}
          {fixed('w0', <Button key="keepwarm-off" label="Off" variant="secondary" onPress={() => chooseWarm('off')} />)}
        </Box>
      ) : isAsking ? (
        <Box key="cq" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {isQuestionInline ? fixed('cqt', <Text size="footnote" weight="medium">Compact now?</Text>) : null}
          {fixed('cy', <Button key="compact-yes" label="Yes" variant="primary" onPress={() => compactNow($)} />)}
          {fixed('cn', <Button key="compact-no" label="No" variant="secondary" onPress={() => update($, viewAtom, old => ({ ...old, compact: 'idle' }))} />)}
        </Box>
      ) : isWorking ? null : (
        fixed('cb', <Button key="compact" label="Compact" variant="secondary" onPress={() => update($, viewAtom, old => ({ ...old, compact: 'ask', isWarmAsking: false }))} />)
      )
    // The pill keeps the width every block's pill has, asking or not: Yes and No fill the room
    // the button and the space before it held, and nothing else on the line moves.
    const contextPill = pillWidth
    const contextNote = !context
      ? note('cn', 'no reading yet')
      : note('cn', `${hasFill ? `${tokens(context.tokens)} of ` : ''}${tokens(context.window)}${compactPercent ? ` · compacts at ${compactPercent}%` : ''}`)
    const contextBlock = block(
      'ctx',
      'Context',
      context
        ? [
            figure('cf', hasFill ? `${fill}%` : '–', fillTone === ACCENT ? undefined : fillTone),
            bar('cb2', fill / 100, fillTone, contextPill, `${fill}% of the context window used`, { still: true }),
            // Right-aligned at rest and while Compact asks; the Keep warm choices centre themselves.
            compactSlot && !isWarmAsking ? <Box key="cs" flexGrow={1} /> : null,
            compactSlot,
          ]
        : [compactSlot],
      [contextNote],
    )

    const card = (
      <Box
        key="card"
        flexDirection="column"
        borderStyle={layout.framed ? 'round' : undefined}
        borderDimColor
        paddingX={layout.framed ? 2 : 1}
        // Without the frame, the steps keep the same small step below them as the one above them,
        // between the row and the card; the terminal draws it as no row, so it costs no line.
        rowGap={layout.framed ? 1 : 'sm'}
      >
        {taskSection}
        <Box key="grid" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={layout.framed ? 1 : 0}>
          {limitBlock('five', '5h limit', limit)}
          {limitBlock('week', '7d limit', week)}
          {turnBlock}
          {contextBlock}
        </Box>
      </Box>
    )
    // A small step between the row and the card: the desktop sizes `sm` on its own scale, the
    // terminal draws it as no row at all, so it never costs the band a line.
    return (
      <Box flexDirection="column" paddingX={1} rowGap="sm">
        {row}
        {card}
      </Box>
    )
  })
}
