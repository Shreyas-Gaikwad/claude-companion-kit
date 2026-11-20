/** How a call ended, when it did not go through: a permission or a hook stopped it, or the tool answered with an error. */
export type Outcome = 'blocked' | 'failed'

/** One call a connector, a website or a search made in this chat. */
export type Call = {
  /** The tool in plain words: "search threads". */
  tool: string
  /** Its main argument, short: a query, an id, a file name, a URL. */
  detail: string
  /** When it started, in milliseconds since the epoch; 0 when unknown. */
  at: number
  /** True for a command-line call made through the shell. */
  cli: boolean
  /** How long it ran, in milliseconds; absent when unknown. */
  ms?: number
  /** Absent when the call went through. */
  outcome?: Outcome
  /** The first line of what went wrong. */
  error?: string
}

/** One connector, with the calls it made. */
export type Connector = {
  /**
   * Its address in the pane: `id-` and the server id for a claude.ai connector,
   * else the name in lower case, letters and digits only.
   */
  key: string
  name: string
  /** False while the name is only the "Connector 1a59" stand-in; a learned name then replaces it. */
  named: boolean
  /** A claude.ai connector's server id, so the Connector names setting can name it as it draws. */
  server?: string
  count: number
  failed: number
  blocked: number
  /** Order of last use: higher is newer. */
  seq: number
  cli: boolean
  mcp: boolean
  /** Newest last; capped. */
  calls: Call[]
}

/** One skill, with how many times this chat used it. */
export type Skill = {
  name: string
  count: number
  seq: number
  /** Loaded at the start through a memory file. */
  always: boolean
}

/** One file this chat read or changed. */
export type FileEntry = {
  /** Full path, with forward slashes. */
  path: string
  /** A memory file the chat loaded at the start (CLAUDE.md, MEMORY.md). */
  memory: boolean
  /** Claude wrote or edited it. */
  edited: boolean
  /** At least one read or edit of it went through. */
  ok: boolean
  failed: number
  blocked: number
  seq: number
}

/** One website the chat fetched pages from, or went to in a browser (the app's own or Chrome). */
export type Site = {
  /** The host, without "www.". */
  host: string
  count: number
  failed: number
  blocked: number
  seq: number
  /** Each fetch, newest last; capped. */
  calls: Call[]
}

/** One subagent this chat started. */
export type Agent = {
  /** The Agent call that started it. */
  callId: string
  /** Its loop's id once known; '' before. */
  id: string
  /** Its agent type: general-purpose, Explore, a plugin's agent. */
  type: string
  /** The Agent call's short description of the task. */
  task: string
  model: string
  startedAt: number
  /** 0 while it runs. */
  endedAt: number
  /** Tool calls it made. */
  tools: number
  /** True when its model requests were counted as they happened, so its creds are known. */
  counted: boolean
  outcome?: Outcome
  seq: number
}

export type Inventory = {
  connectors: Connector[]
  files: FileEntry[]
  skills: Skill[]
  sites: Site[]
  /** Web searches, newest last; capped. */
  searches: Call[]
  agents: Agent[]
  /**
   * Ids of the tool calls already counted, so a reload counts none twice.
   * Each reload drops the ids the chat no longer shows (compacted away), which can never come back.
   */
  counted: string[]
}

/** One skill's instructions as this chat's transcripts carried them, and the turns it was used in. */
export type SkillSpend = {
  /** Its instructions' tokens, the largest of its loads, estimated from their length; 0 when they never loaded here. */
  tokens: number
  /** Times they were loaded: each use, and again each time a compaction kept them. */
  loads: number
  /** Model requests that carried them, the main chat's and subagents'. */
  requests: number
  /** What carrying them cost: a cache write on the first request after each load, a cache read after. */
  creds: number
  /** The answered prompts whose turns used it, and what those turns cost in all, all their other work included. */
  turns: number
  turnCreds: number
}

/** The Session card's figures, worked out from this chat's transcript and its subagents' transcripts. */
export type SessionStats = {
  /** When they were worked out; 0 for never. */
  at: number
  /** Each transcript file with its size and change time, so unchanged files are not read again. */
  source: string
  /** The person's own prompts that Claude answered (a slash command answered locally is none). */
  prompts: number
  /** Model requests, the main chat's and every subagent's. */
  requests: number
  /** Tool calls, the main chat's and every subagent's. */
  tools: number
  /** Time the main chat spent on its turns, in milliseconds. */
  workingMs: number
  /** Input tokens: read from the cache, written to it, and neither. */
  tokens: { read: number; write: number; fresh: number }
  /** Creds by what they paid for, by the price table. */
  creds: { read: number; write: number; fresh: number; output: number }
  /** Main-chat requests that found the cache gone and wrote the context to it again, and their creds. */
  cold: { count: number; creds: number }
  /** The prompt whose work cost the most, subagents' included, with its first words; creds 0 for none. */
  priciest: { creds: number; text: string }
  /** What the answered prompts cost together, for the average. */
  promptCreds: number
  /** Each skill's instructions and turns, by its name. */
  skills: Record<string, SkillSpend>
}

/** One thing loaded into every request, as Claude Code's estimate of the context counts it. */
export type Weight = {
  /** 'c:' and a connector's key, 's:' and a skill's name, 'f:' and a memory file's path. */
  key: string
  name: string
  tokens: number
}

/** What is loaded into every request of the main chat. */
export type Weights = {
  /** The model the main chat runs on, which prices them. */
  model: string
  /** Each connector's loaded tool definitions. */
  connectors: Weight[]
  /** Each skill's listing. */
  skills: Weight[]
  /** Memory files. */
  files: Weight[]
  /** Connectors whose tools all load only when Claude searches for them, so they cost nothing yet. */
  onDemand: string[]
  /** When it was read; 0 for never. */
  at: number
}

/** Creds this chat has used, as counted while the mod runs. */
export type Spend = {
  /** Each Weight's share of the main chat's requests so far, by its key. */
  carried: Record<string, number>
  /** Main-chat requests counted. */
  requests: number
  /** Each subagent's requests by the price table, by its loop's id. */
  byAgent: Record<string, number>
  /**
   * Each subagent's cost in dollars by Claude Code's own estimate, by its loop's id, kept as it grows:
   * the engine forgets it when the process ends. Absent in what a version before 1.9.0 stored.
   */
  agentUsd?: Record<string, number>
}

/** What the mod learned about this chat, for itself. */
export type Meta = {
  /** The transcript file's real path, from the settings hooks' events or a search; '' until known. */
  transcript: string
}

/** One step of this chat's to-do list. */
export type Step = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The present-tense wording, shown while the step runs. */
  active?: string
  /** The task id, where the list came from the task tools. */
  id?: string
}

export type Plan = {
  title: string
  steps: Step[]
  /** Milliseconds since the epoch of the last change; 0 for none. */
  updatedAt: number
}

/** What the person has open and closed in the pane. */
export type View = {
  /** Key of the row whose calls or creds are showing ('c:github', 'w:example.com', 's:code-review', 'searches', 'skills-list'); '' for none. */
  open: string
  /** Cards folded shut: session, todo, connectors, web, agents, files, skills, cost. */
  folded: string[]
  /** True when the file list shows every file, not only the newest. */
  allFiles: boolean
  /** True once the person closed the pane, so it stays closed until /chat-monitor. */
  closed: boolean
  /** How each list is sorted, by its card ('connectors', 'web', 'files', 'skills'); absent, newest first. */
  sort?: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'chat-monitor': {
      inv: Shaped<Inventory>
      plan: Shaped<Plan>
      view: Shaped<View>
      meta: Shaped<Meta>
      weights: Shaped<Weights>
      spend: Shaped<Spend>
      session: Shaped<SessionStats>
      /** The time the pane was last redrawn for, so running subagents' timers move. */
      now: Shaped<number>
    }
  }
}
