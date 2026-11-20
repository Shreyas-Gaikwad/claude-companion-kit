// Gives a connector a name a person recognizes.
// A server with a readable name (mcp__github__...) is named for it. A claude.ai connector shows
// a random id as its server, so it is named from the person's own list (the Connector names
// setting), then from its tool names, and failing both it is "Connector" plus the id's first four.
// Such a connector's row is keyed by its id, so a name learned later renames the row instead of
// starting a second one.

/** MCP servers that are the app's own tools, not an outside service. */
const APP_SERVERS = new Set(['terminal', 'visualize', 'plugin-authoring'])
const isAppServer = (server: string) => server.startsWith('ccd_') || APP_SERVERS.has(server.toLowerCase())

const NAMED: Record<string, string> = {
  'claude-in-chrome': 'Chrome',
  claude_browser: 'Browser',
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  posthog: 'PostHog',
  youtube: 'YouTube',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
  'google-workspace': 'Google Workspace',
  'mcp-registry': 'Connector registry',
  'scheduled-tasks': 'Scheduled tasks',
}

/** Tool names that give a claude.ai connector away. First match wins. */
const BY_TOOL: [RegExp, string][] = [
  [/^notion[-_]/i, 'Notion'],
  [/^slack_/i, 'Slack'],
  [/^fireflies_/i, 'Fireflies'],
  [/^(search_threads|get_thread|list_drafts|create_draft|list_labels)$/i, 'Gmail'],
  [/^(list_calendars|search_events|respond_to_event|suggest_time)$/i, 'Google Calendar'],
  [/^(search_files|read_file_content|get_file_metadata|list_recent_files)$/i, 'Google Drive'],
  [/meeting|transcript/i, 'Meetings'],
  [/certified_quer|live_(results|queries)/i, 'Data queries'],
]

/** Command-line tools that reach an outside service, by their command word. */
const CLI: Record<string, string> = {
  gh: 'GitHub',
  glab: 'GitLab',
  gws: 'Google Workspace',
  gcloud: 'Google Cloud',
  aws: 'AWS',
  az: 'Azure',
  vercel: 'Vercel',
  netlify: 'Netlify',
  supabase: 'Supabase',
  firebase: 'Firebase',
  stripe: 'Stripe',
  wrangler: 'Cloudflare',
  heroku: 'Heroku',
}
const CLI_RE = new RegExp(`(?:^|[;&|(\\n\`]|\\$\\()\\s*(${Object.keys(CLI).join('|')})(?:\\.exe)?\\s+([^;&|\\n\`)]*)`, 'g')

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

const words = (text: string) =>
  text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')

const isId = (server: string) => /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(server)

// The person's own names for id servers.
let own: [string, string][] = []

/** Reads the Connector names setting: "1a59=Docs, 7a9f=Meetings". */
export function setOwnNames(setting: string) {
  own = setting
    .split(',')
    .map(pair => pair.split('='))
    .filter(pair => pair.length === 2 && pair[0]!.trim() && pair[1]!.trim())
    .map(pair => [pair[0]!.trim().toLowerCase(), pair[1]!.trim()])
}

/** The person's own name for an id server, from the Connector names setting. */
export const ownNameOf = (server: string) => own.find(([id]) => server.toLowerCase().startsWith(id))?.[1]

export type ConnectorHit = {
  /** The row's address: `id-` and the server id for a claude.ai connector, else the name in lower case. */
  key: string
  name: string
  /** False while the name is only the "Connector 1a59" stand-in. */
  named: boolean
  /** A claude.ai connector's server id, in lower case. */
  server?: string
  tool: string
}

/** The connector an MCP tool belongs to, or undefined when the tool is the app's own. */
export function connectorOf(tool: string): ConnectorHit | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const [, server = '', ...rest] = tool.split('__')
  const toolName = rest.join('__')
  if (!server || isAppServer(server)) return undefined
  if (!isId(server)) {
    const bare = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '') || server
    const name = NAMED[bare.toLowerCase()] ?? words(bare)
    return { key: slug(name), name, named: true, tool: toolName }
  }
  const id = server.toLowerCase()
  const base = { key: `id-${id}`, server: id, tool: toolName }
  const mine = ownNameOf(id)
  if (mine) return { ...base, name: mine, named: true }
  const hit = BY_TOOL.find(([pattern]) => pattern.test(toolName))
  return hit ? { ...base, name: hit[1], named: true } : { ...base, name: `Connector ${id.slice(0, 4)}`, named: false }
}

/** "fireflies_get_transcripts" for Fireflies reads "get transcripts". */
export function plainTool(toolName: string, connector: string): string {
  const parts = toolName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase())
  const ownWords = new Set([slug(connector), ...connector.toLowerCase().split(/\s+/)])
  while (parts.length > 1 && ownWords.has(parts[0]!)) parts.shift()
  return parts.join(' ')
}

/** The service calls inside one shell command: each service once, with its subcommand. */
export function cliCalls(command: string): { name: string; tool: string; detail: string }[] {
  const found = new Map<string, { name: string; tool: string; detail: string }>()
  for (const match of command.matchAll(CLI_RE)) {
    const name = CLI[match[1]!]!
    const parts = (match[2] ?? '').trim().split(/\s+/).filter(Boolean)
    // The subcommand is the plain words the line opens with: "pr list", "run".
    let lead = 0
    while (lead < 2 && /^[a-z][a-z-]*$/i.test(parts[lead] ?? '')) lead += 1
    const sub = parts.slice(0, lead).join(' ')
    const detail = parts.slice(lead).join(' ')
    const id = `${name}|${sub}`
    if (!found.has(id)) found.set(id, { name, tool: sub || 'run', detail })
  }
  return [...found.values()]
}
