/** One step of the task's to-do list. */
export type Step = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The present-tense wording, shown while the step runs. */
  active?: string
  /** The task id, where the list came from the task tools. */
  id?: string
  /** When the step was first seen running, in milliseconds since the epoch. */
  startedAt?: number
  /** When a step seen running was checked off. */
  endedAt?: number
}

/** The work on the latest prompt. */
export type Work = {
  /** When the prompt's turn began, in milliseconds since the epoch; 0 before any prompt. */
  startedAt: number
  /** When it ended; 0 while Claude is still working. */
  endedAt: number
  /** Tool calls made so far. */
  tools: number
  /** The to-do list Claude keeps for the task; empty when it keeps none. */
  steps: Step[]
}

/** The 5-hour limit as the last response reported it. */
export type Limit = {
  /** 0 to 100. */
  percentUsed: number
  /** When the window resets, in milliseconds since the epoch; 0 when unknown. */
  resetsAt: number
}

/** What the latest prompt has used so far, its subagents included. */
export type TurnUse = {
  /** Input tokens neither read from nor written to the cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The session's cost in US dollars when the prompt began; -1 where the host keeps no ledger. */
  costFrom: number
  /** The session's cost now; -1 where the host keeps no ledger. */
  cost: number
  /**
   * Creds from the price table: every token counted at its price, in tokens of Claude
   * Opus 5.5 input ($4 per million), whichever model answered. Used where there is no cost ledger.
   */
  weighted: number
  /** The 5-hour limit when the prompt began, so the band can say how far the turn moved it; null without a reading. */
  fiveFrom: Limit | null
  /** The 7-day limit when the prompt began; null without a reading. */
  weekFrom: Limit | null
  /** Points of the 5-hour limit the turn used in windows that ended during it. */
  fiveCarried: number
  /** Points of the 7-day limit the turn used in windows that ended during it. */
  weekCarried: number
}

/** The live context window. */
export type Context = {
  /** Tokens the last response was answered over; -1 before a response of the live window. */
  tokens: number
  window: number
  /** The token count at which Claude Code compacts the chat; 0 when unknown or auto-compaction is off. */
  compactAt: number
}

/** What one keepwarm ping read back. */
export type Ping = {
  /** When it went out. */
  at: number
  /** Tokens the cache served it. */
  read: number
  /** What it cost, in creds. */
  creds: number
}

/** Keepwarm: pings that keep the prompt cache warm while the chat sits idle. */
export type Warm = {
  /** When the window ends, in milliseconds since the epoch; 0 while keepwarm is off. */
  deadline: number
  /** How long the cache sits idle before a ping. */
  every: number
  /** The always window in milliseconds, renewed after every turn; 0 while always is off. */
  always: number
  /** Why keepwarm stopped on its own; empty unless it did. */
  stopped: string
  /** There is nothing to fork until the next turn, as after a restart or a compaction. */
  waiting: boolean
  /** Retries of a ping the API turned away as busy. */
  retries: number
  /** The last ping's readback; null before the first. */
  last: Ping | null
}

/** A model switch since the main thread's last request: none of the chat is cached on the new model. */
export type Switch = {
  /** The model the chat's cache is on. */
  from: string
  /** The model the next send goes to. */
  to: string
}

/** The band's own controls. */
export type View = {
  /** Whether the details below the row are open. */
  isOpen: boolean
  /** The Compact button: at rest, asking yes or no, or compacting. */
  compact: 'idle' | 'ask' | 'running'
  /** The Keep warm button was pressed: 3h, 6h and Off stand where Compact does. */
  isWarmAsking?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    taskband: {
      work: Work
      /** Null until a response has reported the window. */
      limit: Limit | null
      /** The 7-day limit; null until a response has reported it. */
      week: Limit | null
      use: TurnUse
      /** Null until the engine has reported the window. */
      context: Context | null
      view: View
      /** When the last request went out, which is when the cache was last refreshed; 0 for none. */
      cacheAt: number
      /** Keepwarm's window, schedule and last readback. */
      warm: Warm
      /** The model the main thread last asked, which prices a cold send; empty before it is known. */
      model: string
      /**
       * By model: tokens at the head of the prompt (the tools and system prompt) that the last send
       * into a cold cache, after a compaction or after a switch to that model still read from the
       * cache. A model with none measured counts 0.
       */
      prefixes: Record<string, number>
      /** A switch since the main thread's last request; null when there was none or it switched back. */
      switched: Switch | null
      /** The time the band was last redrawn for, so the countdowns move. */
      now: number
    }
  }
}
