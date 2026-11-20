// Creds, counted as the taskband mod counts them, so the two agree.
//
// A cred is a token counted at its price, in tokens of Claude Opus 5.5 input ($4 per million), so
// one cred is $0.000004 of usage whichever model answered. Where Claude Code keeps a cost ledger,
// creds are its cost ÷ $4 per million: the session's total, and each subagent's own figure where
// Claude Code has one. Every other figure (a skill, a connector, a prompt, reads against writes)
// comes from this table as it stands, unscaled:
//
//   creds = (model's input price ÷ $4) × (new + r × cache read + c × cache write + 5 × out)
//
// r is the model's cache-read share of its input price, c is 2 for the 1-hour cache and 1.25 for
// the 5-minute one, and output costs five times input on every current model.
//
// Which cache a write went to: the split the API reports, where the request's usage carries it;
// else the 5-minute cache for a subagent, which writes only there, and the Cache lifetime setting
// for the main chat. Taskband prices a subagent by the setting, but only where it has no ledger.
//
// PRICES is a copy of taskband's table: a model added there belongs here too.

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
/** What one cred stands for, in dollars. */
export const DOLLARS_PER_CRED = REFERENCE_PRICE / 1_000_000

let cacheLife = 60 * 60_000
/** The Cache lifetime setting: 60 minutes on a subscription, 5 once billed as extra usage. */
export const setCacheMinutes = (minutes: number) => {
  cacheLife = (minutes === 5 ? 5 : 60) * 60_000
}
/** A cache write costs twice the input price on the 1-hour cache, 1.25 times on the 5-minute one. */
const LONG_WRITE = 2
const SHORT_WRITE = 1.25
const writeTimes = () => (cacheLife > 5 * 60_000 ? LONG_WRITE : SHORT_WRITE)

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** The writes by cache, as the API reports them; absent where the engine does not pass them on. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
  model?: string
}

/**
 * One model, read the same from a response, a switch or /model: "claude-opus-5-5[1m]",
 * "claude-opus-4-1-20250805" and "Opus 5.5 (1M context)" give "claude-opus-5-5", "claude-opus-4-1"
 * and "claude-opus-5-5". An alias with no version, such as "opus", is left as it is.
 */
export function modelKey(model: string) {
  const text = model.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim()
  const found = /^(?:claude[- ])?([a-z]+)[- ](\d+)(?:[.-](\d{1,2}))?(?!\d)/.exec(text)
  return found ? `claude-${found[1]}-${found[2]}${found[3] ? `-${found[3]}` : ''}` : text
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; an id of another form as it is. */
export function modelName(model: string) {
  const key = modelKey(model)
  const found = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(key)
  return found ? `${found[1]!.charAt(0).toUpperCase()}${found[1]!.slice(1)} ${found[2]!.replace('-', '.')}` : key
}

/** A model's input price in dollars per million for a prompt of this many tokens, and its cache-read share. */
function priceOf(model: string | undefined, prompt: number): [number, number] {
  const name = (model ?? '').toLowerCase()
  const key = modelKey(name)
  const [one, listed, readShare] = PRICES.find(([id]) => name.includes(id)) ?? PRICES.find(([id]) => key.includes(id)) ?? ['', REFERENCE_PRICE, 0.05]
  // Claude Haiku 5.5 costs five times as much on a prompt over 100k tokens.
  return [one === 'haiku-5-5' && prompt > 100_000 ? 0.5 : listed, readShare]
}

/** One request's creds by what they paid for: new input, cache reads, cache writes and output. */
export type CredsByKind = { fresh: number; read: number; write: number; output: number }

/**
 * One request's creds by kind, weighted by its model's prices. Its cache writes are priced by the
 * cache they went to: the API's split where the usage has it, else the 5-minute cache for a subagent.
 */
export function credsByKind(used: Usage, isSubagent = false): CredsByKind {
  const input = used.input_tokens || 0
  const read = used.cache_read_input_tokens || 0
  const write = used.cache_creation_input_tokens || 0
  const output = used.output_tokens || 0
  const short = used.cache_creation?.ephemeral_5m_input_tokens || 0
  const long = used.cache_creation?.ephemeral_1h_input_tokens || 0
  const unsplit = Math.max(0, write - short - long)
  const writes = SHORT_WRITE * short + LONG_WRITE * long + (isSubagent ? SHORT_WRITE : writeTimes()) * unsplit
  const [price, readShare] = priceOf(used.model, input + read + write)
  const scale = price / REFERENCE_PRICE
  return { fresh: scale * input, read: scale * readShare * read, write: scale * writes, output: scale * OUTPUT_TIMES * output }
}

/** One request's creds, all kinds together. */
export function weigh(used: Usage, isSubagent = false): number {
  const kinds = credsByKind(used, isSubagent)
  return kinds.fresh + kinds.read + kinds.write + kinds.output
}

/** What `tokens` of a request cost when the cache serves them. */
export function readCreds(model: string, tokens: number, prompt = tokens) {
  const [price, readShare] = priceOf(model, prompt)
  return (price / REFERENCE_PRICE) * readShare * tokens
}

/** What `tokens` of a request cost when they are written to the cache again; a subagent writes only to the 5-minute cache. */
export function writeCreds(model: string, tokens: number, prompt = tokens, isSubagent = false) {
  const [price] = priceOf(model, prompt)
  return (price / REFERENCE_PRICE) * (isSubagent ? SHORT_WRITE : writeTimes()) * tokens
}

/** 840, 4.8k, 52k, 1.2M. */
export function amount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
