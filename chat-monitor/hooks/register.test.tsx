import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const CWD = 'C:\\Users\\test\\projects\\My App'
const ID_SERVER = '1a59c906-04da-521d-bda7-7f71b9f9e01c'

type Use = { tool_use_id: string; tool: string; input: Record<string, unknown>; agentId?: string; text?: string }
type World = {
  uses: Use[]
  typed: string
  opens: number
  closes: number
  isUp: boolean
  memory: string[]
  /** Environment variables beyond USERPROFILE. */
  env?: Record<string, string>
  /** Files on disk by forward-slash path, with their text. */
  files?: Record<string, string>
  /** Folders on disk by forward-slash path, with the folders inside each. */
  dirs?: Record<string, string[]>
  /** Every path the mod read, in order. */
  reads?: string[]
  /** How many bytes the mod read of each file, by path; counted when given. */
  readBytes?: Record<string, number>
  /** What a tool call answers, by its id; `{ result: {} }` for any other. */
  answers?: Record<string, unknown>
  /** How long a tool call runs on the mocked clock, by its id. */
  delays?: Record<string, number>
  /** What happens while a tool call runs (a subagent's spawn, its requests, its calls), by its id. */
  scripts?: Record<string, ($: never) => Promise<void>>
  /** The usage each model request reports, in order. */
  usage?: unknown[]
  /** Connector tools in the context, each with its tokens, and the main model. */
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  model?: string
  /** Each memory file's tokens, by its path. */
  memoryTokens?: Record<string, number>
  /** The session's cost by the ledger; absent where there is none. */
  ledgerUsd?: number
  /** The subagents `$.agent.list()` answers, each with Claude Code's own cost for it. */
  agents?: { id: string; cost?: { usd: number } }[]
  /** When the session began, as `$.session.usage()` reports it. */
  startedAt?: number
  /** False: the surface has no clipboard. */
  clipboard?: boolean
  copied?: string[]
  notices?: string[]
}

const flat = (path: string) => path.replace(/\\/g, '/')
const utf8 = new TextEncoder()
const FOUR_MIB = 4 * 1024 * 1024
function base64Of(bytes: Uint8Array): string {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(raw)
}
const SKILLS = [
  { name: 'code-review', tokens: 100 },
  { name: 'deploy', tokens: 200 },
]

// Stands in for the engine: every call the mod makes on `$` is answered from `world`.
function engine(on: On, world: World) {
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: { command: 'chat-monitor' } }) as never)
  on('env.get', async ($, e) => {
    const { name } = e as { name: string }
    return { value: name === 'USERPROFILE' ? 'C:\\Users\\test' : world.env?.[name] } as never
  })
  on('classic.SessionStart', async () => ({}) as never)
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('session.cwd', async () => ({ value: CWD }) as never)
  on('session.usage', async () =>
    ({
      value: {
        context: {
          tokens: 1000,
          window: 200_000,
          breakdown: {
            model: world.model ?? 'claude-opus-5-5',
            memoryFiles: world.memory.map(path => ({ path, type: 'User', tokens: world.memoryTokens?.[path] ?? 0 })),
            skills: { skillFrontmatter: SKILLS },
            mcpTools: world.mcpTools ?? [],
          },
        },
        ...(world.ledgerUsd !== undefined ? { cost: { usd: world.ledgerUsd } } : {}),
        ...(world.startedAt !== undefined ? { startedAt: world.startedAt } : {}),
      },
    }) as never,
  )
  on('agent.list', async () => ({ value: world.agents ?? [] }) as never)
  on('agent.spawn', async ($, e) => ({ model: 'claude-haiku-5-5', agentId: `agent-${(e as { tool_use_id: string }).tool_use_id}` }) as never)
  on('turn.step', async function* ($, e) {
    const step = e as { turnId: string; index: number }
    return { turnId: step.turnId, index: step.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: world.usage?.shift() ?? null } as never
  })
  on('ui.copy', async ($, e) => {
    if (world.clipboard === false) return { value: { isCopied: false, reason: 'no-clipboard' } } as never
    world.copied?.push((e as { text: string }).text)
    return { value: { isCopied: true } } as never
  })
  on('session.append', async ($, e, next) => {
    const row = e as unknown as { message: { type: string; content: { text?: string }[] } }
    if (row.message.type === 'system') world.notices?.push(row.message.content[0]?.text ?? '')
    return next(e)
  })
  on('session.messages', async () =>
    ({
      value: [
        { role: 'user', text: world.typed, toolUses: [] },
        { role: 'assistant', text: 'Working on it.', toolUses: world.uses },
      ],
    }) as never,
  )
  on('fs.exists', async ($, e) => ({ value: world.files?.[flat((e as { path: string }).path)] !== undefined }) as never)
  on('fs.stat', async ($, e) => {
    const text = world.files?.[flat((e as { path: string }).path)]
    if (text === undefined) throw new Error('ENOENT: no such file')
    return { value: { kind: 'file', size: utf8.encode(text).length, mtimeMs: 0, isLink: false } } as never
  })
  // As the engine reads: the text or its bytes as base64, a byte range when asked, and never over 4 MiB a read.
  on('fs.read', async ($, e) => {
    const { path: raw, as, offset, length } = e as { path: string; as?: string; offset?: number; length?: number }
    const path = flat(raw)
    world.reads?.push(path)
    const bytes = utf8.encode(world.files?.[path] ?? '')
    const from = offset ?? 0
    const to = length === undefined ? bytes.length : Math.min(bytes.length, from + length)
    if ((length ?? 0) > FOUR_MIB || to - from > FOUR_MIB) throw new Error('A read over 4 MiB is refused')
    if (world.readBytes) world.readBytes[path] = (world.readBytes[path] ?? 0) + Math.max(0, to - from)
    const part = bytes.subarray(from, Math.max(from, to))
    return { value: as === 'bytes' ? { base64: base64Of(part) } : new TextDecoder().decode(part) } as never
  })
  on('fs.list', async ($, e) =>
    ({ value: (world.dirs?.[flat((e as { path: string }).path)] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }) as never,
  )
  on('fs.write', async () => ({ value: undefined }) as never)
  on('tool.call', async ($, e) => {
    const id = (e as { tool_use_id?: string }).tool_use_id ?? ''
    await world.scripts?.[id]?.($ as never)
    const wait = world.delays?.[id]
    if (wait) await clock.sleep(wait)
    return (world.answers?.[id] ?? { result: {} }) as never
  })
  on('ui.panes', async () => ({ value: world.isUp ? [{ id: 'chat-monitor', title: 'In this chat' }] : [] }) as never)
  on('ui.open', async () => {
    world.opens += 1
    world.isUp = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => {
    world.closes += 1
    world.isUp = false
    return { value: undefined } as never
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 9, 30) })
  return clock
}

type Clock = ReturnType<typeof engine>

/** A tool call as the engine makes it, then the moment the pane takes to catch up. */
async function callTool($: { tool: { call: (e: never) => Promise<unknown> } }, clock: Clock, input: Record<string, unknown>) {
  const ran = await $.tool.call(input as never)
  await clock.settle()
  return ran
}

/** One model request, read to its end as the engine reads it. */
async function step($: { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> } }, input: Record<string, unknown>) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...input } as never)
  for await (const chunk of stream) void chunk
}

const earlier = (): Use[] => [
  { tool_use_id: 'p1', tool: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Read the code', status: 'in_progress' }, { content: 'Write the fix', status: 'pending' }, { content: 'Run the tests', status: 'pending' }] } },
  { tool_use_id: 't1', tool: 'Read', input: { file_path: 'C:\\Users\\test\\projects\\My App\\src\\import.ts' } },
  { tool_use_id: 't2', tool: 'Read', input: { file_path: 'C:\\Users\\test\\AppData\\Local\\Temp\\claude\\spill.txt' } },
  { tool_use_id: 't3', tool: 'Edit', input: { file_path: 'C:\\Users\\test\\projects\\My App\\src\\import.ts' } },
  { tool_use_id: 't4', tool: 'Skill', input: { skill: 'code-review' } },
  { tool_use_id: 't5', tool: 'PowerShell', input: { command: 'cd repo; gh pr list --state open' } },
  { tool_use_id: 't6', tool: 'mcp__github__list_issues', input: { query: 'importer crash' } },
  { tool_use_id: 't7', tool: `mcp__${ID_SERVER}__read`, input: { id: 'doc-7' } },
  { tool_use_id: 'p2', tool: 'mcp__ccd_turn__update_plan', input: { advance: true } },
]

const fresh = (): World => ({ uses: earlier(), typed: '<command-name>/deploy</command-name>', opens: 0, closes: 0, isUp: false, memory: ['C:\\Users\\test\\.claude\\CLAUDE.md'] })
const blank = (): World => ({ uses: [], typed: 'hello', opens: 0, closes: 0, isUp: false, memory: [] })

// A transcript in Claude Code's own form: one line per assistant message, with its time.
const STAMP = '2026-11-16T08:15:00.000Z'
const transcriptOf = (ids: string[]) => ids.map(id => JSON.stringify({ type: 'assistant', timestamp: STAMP, message: { content: [{ type: 'tool_use', id, name: 'x', input: {} }] } })).join('\n')
// The pane shows local time, so the expected time is worked out the same way.
const two = (n: number) => String(n).padStart(2, '0')
const shownTime = (stamp: string) => `${two(new Date(stamp).getHours())}:${two(new Date(stamp).getMinutes())}`
const props = { title: 'In this chat', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const start = ($: { session: { start: (e: never) => Promise<unknown> } }, surface: string) => $.session.start({ source: 'startup', cwd: CWD, surface, isInteractive: true } as never)

for (const surface of ['desktop', 'terminal'] as const) {
  test(`what the chat did before the mod loaded is in the pane (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
    const world = fresh()
    const clock = engine(on as never, world)
    await start($ as never, surface)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'chat-monitor', surface, component: 'Pane', requestId: 'chat-monitor', props })
    const pane = async () => ui
    const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
    expect(world.opens, 'a chat that already used things opens its pane').toBe(1)

    expect(await has(/^1 of 3$/), 'the to-do figure').toBe('1 of 3')
    expect(await has(/Write the fix/), 'the second step').toBeDefined()
    expect(await has(/2 calls/), 'gh and the GitHub connector are one connector').toBeDefined()
    expect(await has(/Connector 1a59/), 'an id server with no name').toBeDefined()
    expect(await has(/^import\.ts$/), 'the file').toBeDefined()
    expect(await has(/^~\/projects\/My App\/src$/), 'its folder, under its name').toBeDefined()
    expect(await has(/^edited$/), 'it was edited').toBe('edited')
    expect(await has(/spill\.txt/), 'a scratch file is left out').toBeUndefined()
    expect(await has(/CLAUDE\.md/), 'the memory file').toBeDefined()
    expect(await has(/code-review/), 'the skill tool').toBeDefined()
    expect(await has(/deploy/), 'the typed skill').toBeDefined()

    // A press on the connector shows its calls, newest first; a second press hides them.
    expect(await has(/importer crash/), 'calls are folded away at first').toBeUndefined()
    await (await pane()).press({ key: 'c:github' })
    expect(await has(/importer crash/), 'the MCP call with its query').toContain('list issues')
    expect(await has(/pr list/), 'the CLI call').toContain('--state open')
    await (await pane()).press({ key: 'c:github' })
    expect(await has(/importer crash/)).toBeUndefined()

    // A section header folds its rows.
    await (await pane()).press({ key: 'sec-files' })
    expect(await has(/import\.ts/), 'files folded').toBeUndefined()
    await (await pane()).press({ key: 'sec-files' })
    expect(await has(/import\.ts/), 'files open again').toBeDefined()

    // A reload reads the same chat again and counts nothing twice.
    await start($ as never, surface)
    await clock.settle()
    expect(await has(/2 calls/), 'still two').toBeDefined()
    expect(await has(/3 calls/)).toBeUndefined()
    expect(await has(/^1 of 3$/), 'the list did not advance again').toBeDefined()
  })
}

test('live calls are counted once, open the pane, and move the to-do list', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { uses: [], typed: 'hello', opens: 0, closes: 0, isUp: false, memory: [] }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const pane = async () => ui
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  expect(world.opens, 'an empty chat opens nothing').toBe(0)
  expect(await has(/None used yet/)).toBeDefined()

  await callTool($ as never, clock, { tool: 'Read', tool_use_id: 'a1', file_path: 'C:\\Users\\test\\notes\\plan.md' })
  await callTool($ as never, clock, { tool: 'Read', tool_use_id: 'a1', file_path: 'C:\\Users\\test\\notes\\plan.md' })
  expect(world.opens, 'the first thing used opens the pane').toBe(1)
  expect(await has(/plan\.md/), 'the file shows').toBeDefined()
  await (await pane()).press({ key: 'hide' })
  expect(world.closes, 'Hide closes the pane').toBe(1)

  await callTool($ as never, clock, { tool: 'TodoWrite', tool_use_id: 'a2', todos: [{ content: 'Draft', status: 'in_progress', activeForm: 'Drafting' }, { content: 'Send', status: 'pending' }] })
  expect(await has(/Drafting/), 'the running step shows its present-tense wording').toBeDefined()
  expect(await has(/^0 of 2$/)).toBeDefined()

  await callTool($ as never, clock, { tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a3', items: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' }] })
  await callTool($ as never, clock, { tool: 'mcp__ccd_turn__wrap_up', tool_use_id: 'a4', recap: 'Done.' })
  expect(await has(/^2 of 2$/), 'wrapping up checks off the running step').toBeDefined()
  expect(await has(/Ccd/), 'the app\'s own tools are not connectors').toBeUndefined()

  // More files than fit: the newest few, then all of them on request.
  for (let i = 0; i < 10; i += 1) await callTool($ as never, clock, { tool: 'Write', tool_use_id: `w${i}`, file_path: `C:\\Users\\test\\out\\file${i}.txt` })
  expect(await has(/file0\.txt/), 'the oldest is folded away').toBeUndefined()
  await (await pane()).press({ key: 'files-all' })
  expect(await has(/file0\.txt/), 'all files').toBeDefined()

  await $.command.run({ command: 'chat-monitor' } as never)
  expect(world.opens, '/chat-monitor opens the pane again').toBe(2)
})

test('the names setting labels an id connector, and off keeps the pane shut', { options: { names: '1a59=Docs', autoOpen: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const world = fresh()
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  expect(world.opens, 'off opens nothing by itself').toBe(0)

  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  expect((await ui.find({ type: 'Text', text: /^Docs$/ }))?.text, 'named from the setting').toBe('Docs')
  expect(await ui.find({ type: 'Text', text: /Connector 1a59/ })).toBeUndefined()
})

// Bugs 1 and 2.
test('a claude.ai connector keeps one row as it learns its name, and the app\'s own tools are no connectors', { timeoutMs: 30_000 }, async ($, on) => {
  const world = blank()
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  await callTool($ as never, clock, { tool: `mcp__${ID_SERVER}__read`, tool_use_id: 'n1', id: 'page-1' })
  expect(await has(/Connector 1a59/), 'a stand-in name at first').toBeDefined()
  await callTool($ as never, clock, { tool: `mcp__${ID_SERVER}__notion-search`, tool_use_id: 'n2', query: 'roadmap' })
  expect(await has(/^Notion$/), 'named once a tool gives it away').toBeDefined()
  expect(await has(/Connector 1a59/), 'the same row, renamed: no second row').toBeUndefined()
  expect(await has(/^2 calls$/)).toBeDefined()

  // After a reload, a call that gives nothing away still lands on the Notion row.
  await start($ as never, 'desktop')
  await clock.settle()
  await callTool($ as never, clock, { tool: `mcp__${ID_SERVER}__read`, tool_use_id: 'n3', id: 'page-2' })
  expect(await has(/Connector 1a59/)).toBeUndefined()
  expect(await has(/^3 calls$/)).toBeDefined()

  for (const tool of ['mcp__terminal__read_terminal', 'mcp__visualize__show_widget', 'mcp__plugin-authoring__scan_secrets', 'mcp__ccd_session__mark_chapter']) {
    await callTool($ as never, clock, { tool, tool_use_id: tool, title: 'x' })
  }
  expect(await has(/Terminal|Visualize|Plugin Authoring|Ccd/), 'the app\'s own tools are not connectors').toBeUndefined()
})

// Bug 3.
test('one file is one row however Windows spells its path', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { ...blank(), env: { TEMP: 'C:\\Users\\TEST~1\\AppData\\Local\\Temp' } }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  await callTool($ as never, clock, { tool: 'Read', tool_use_id: 'f1', file_path: 'C:\\Users\\test\\notes\\plan.md' })
  await callTool($ as never, clock, { tool: 'Edit', tool_use_id: 'f2', file_path: 'c:\\users\\TEST\\Notes\\Plan.md' })
  await callTool($ as never, clock, { tool: 'Read', tool_use_id: 'f3', file_path: 'C:\\Users\\TEST~1\\notes\\plan.md' })
  expect(await has(/plan\.md/), 'shown as first read').toBe('plan.md')
  expect(await has(/^~\/notes$/), 'under the home folder').toBeDefined()
  expect(await has(/^edited$/), 'the edit is on the same row').toBe('edited')
  expect(await has(/^[2-9]$/), 'one file, not three').toBeUndefined()
  expect(await has(/^1$/)).toBeDefined()
})

// Bug 4.
test('call times come from the transcript the settings hooks name, read only when there is something new', { timeoutMs: 30_000 }, async ($, on) => {
  const transcript = 'D:/archive/chats/session-1.jsonl'
  const world: World = { ...fresh(), files: { [transcript]: transcriptOf(['t5', 't6']) }, reads: [] }
  const clock = engine(on as never, world)
  await $.classic.SessionStart({ source: 'resume', transcript_path: transcript } as never)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  await ui.press({ key: 'c:github' })
  expect(await has(new RegExp(`^${shownTime(STAMP)}$`)), 'the MCP call shows when it was made').toBeDefined()
  const readsOfTranscript = () => world.reads!.filter(path => path === transcript).length
  expect(readsOfTranscript(), 'read once, for the new calls').toBe(1)

  await start($ as never, 'desktop')
  await clock.settle()
  expect(readsOfTranscript(), 'a reload with nothing new leaves it unread').toBe(1)
})

test('a transcript filed under another folder name is found by the chat\'s id', { timeoutMs: 30_000 }, async ($, on) => {
  const projects = 'C:/Users/test/.claude/projects'
  // Claude Code shortened the folder name and added a hash, so the cwd does not lead to it.
  const filed = `${projects}/C--Users-test-projects-My-App-1f3a9c/session-1.jsonl`
  const world: World = { ...fresh(), files: { [filed]: transcriptOf(['t5', 't6']) }, dirs: { [projects]: ['C--Users-test-other', 'C--Users-test-projects-My-App-1f3a9c'] } }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })

  await ui.press({ key: 'c:github' })
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${shownTime(STAMP)}$`) }))?.text, 'found and read').toBeDefined()
})

// Bug 5.
test('a long chat is never counted twice, and calls compacted away stay counted', { timeoutMs: 60_000 }, async ($, on) => {
  const many: Use[] = Array.from({ length: 4100 }, (_, i) => ({ tool_use_id: `g${i}`, tool: 'PowerShell', input: { command: `gh issue view ${i}` } }))
  const world: World = { ...blank(), uses: many }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  expect(await has(/^4100 calls$/)).toBeDefined()

  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/^4100 calls$/), 'a reload counts none of them again').toBeDefined()

  // Compaction: the old calls leave the chat and a new one arrives.
  world.uses = [{ tool_use_id: 'h1', tool: 'PowerShell', input: { command: 'gh pr list' } }]
  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/^4101 calls$/), 'the new call is added to the old ones').toBeDefined()
  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/^4101 calls$/), 'and counted once').toBeDefined()
})

// 1.4.0: failed and blocked calls, the web card, calls running now and the slowest calls.
test('failed and blocked calls, websites and searches, and no Activity card', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    ...blank(),
    answers: {
      b1: { deny: 'Blocked by policy: no new issues' },
      f1: { result: 'Request failed with status code 404', isError: true, text: '<tool_use_error>Request failed with status code 404</tool_use_error>' },
    },
    delays: { s1: 45_000 },
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  await callTool($ as never, clock, { tool: 'mcp__github__list_issues', tool_use_id: 'g1', query: 'crash' })
  await callTool($ as never, clock, { tool: 'mcp__github__create_issue', tool_use_id: 'b1', title: 'Crash' })
  expect(await has(/· 1 blocked/), 'the blocked call is on the GitHub row').toBeDefined()
  await ui.press({ key: 'c:github' })
  expect(await has(/^⊘ create issue/), 'and marked among its calls').toBeDefined()
  expect(await has(/Blocked by policy/), 'with what blocked it').toBeDefined()

  await callTool($ as never, clock, { tool: 'WebFetch', tool_use_id: 'f1', url: 'https://www.example.com/docs/a', prompt: 'x' })
  await callTool($ as never, clock, { tool: 'WebFetch', tool_use_id: 'f2', url: 'https://example.com/docs/b', prompt: 'x' })
  await callTool($ as never, clock, { tool: 'WebSearch', tool_use_id: 'q1', query: 'claude code mods' })
  expect(await has(/^example\.com$/), 'one row for the site, www or not').toBeDefined()
  expect(await has(/^2 pages · 1 failed$/)).toBeDefined()
  await ui.press({ key: 'w:example.com' })
  expect(await has(/^✕ fetch/), 'the failed fetch is marked, by its path').toBe('✕ fetch  /docs/a')
  expect(await has(/status code 404/), 'with its error').toBeDefined()
  await ui.press({ key: 'searches' })
  expect(await has(/claude code mods/), 'the search').toBeDefined()

  // A long call shows nowhere while it runs, and joins no slowest-calls list once done: there is no Activity card.
  const slow = $.tool.call({ tool: 'PowerShell', tool_use_id: 's1', command: 'npm test' } as never)
  await clock.settle()
  await clock.advance(2_000)
  expect(await has(/^PowerShell {2}npm test$/), 'no Running now row').toBeUndefined()
  expect(await has(/^Activity$/), 'no Activity card').toBeUndefined()
  await clock.advance(43_000)
  await slow
  await clock.settle()
  expect(await has(/^Slowest calls/), 'no Slowest calls list').toBeUndefined()
})

// 1.5.0: pages a browser went to are web, each under the page it landed on.
const tabContext = (title: string, url: string) => `\n\n\nTab Context:\n- Executed on tabId: seed\n- Available tabs:\n  • tabId seed: "${title}" ("${url}")`
// A batch's answer as the browser gives it: each step's part opens with "[name] ".
const BATCH_TEXT = [
  '[navigate] {\n  "tabId": "seed",\n  "navOk": true\n}\nBrowser pane opened.',
  `[get_page_text] Title: Ithihasa\nURL: https://en.wikipedia.org/wiki/Ithihasa\n---\nIthihasa is a 2014 film.\n[edit] Plot${tabContext('Ithihasa - Wikipedia', 'https://en.wikipedia.org/wiki/Ithihasa')}`,
  `[navigate] navigated to https://en.wikipedia.org/wiki/Special:Random${tabContext('Cobie Sikkens - Wikipedia', 'https://en.wikipedia.org/wiki/Cobie_Sikkens')}`,
  `[get_page_text] Title: Cobie Sikkens\nURL: https://en.wikipedia.org/wiki/Cobie_Sikkens\n---\nA Dutch swimmer.${tabContext('Cobie Sikkens - Wikipedia', 'https://en.wikipedia.org/wiki/Cobie_Sikkens')}`,
].join('\n')

test('pages a browser went to are web, by the page each landed on; clicks and local previews stay on the Browser row', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    ...blank(),
    // Before the mod loaded, the browser went to a page that redirected.
    uses: [{ tool_use_id: 'old1', tool: 'mcp__Claude_Browser__navigate', input: { url: 'https://docs.python.org/3' }, text: `navigated to https://docs.python.org/3${tabContext('3.13 Documentation', 'https://docs.python.org/3/')}` }],
    answers: {
      v1: { result: {}, text: BATCH_TEXT },
      v2: { result: {}, text: `navigated to http://localhost:3000${tabContext('My App', 'http://localhost:3000/')}` },
    },
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  expect(await has(/^docs\.python\.org$/), 'a page from before the mod loaded').toBeDefined()
  await ui.press({ key: 'w:docs.python.org' })
  expect(await has(/^browser {2}\/3\/$/), 'by where it landed').toBeDefined()

  const random = { name: 'navigate', input: { url: 'https://en.wikipedia.org/wiki/Special:Random' } }
  await callTool($ as never, clock, { tool: 'mcp__Claude_Browser__browser_batch', tool_use_id: 'v1', actions: [random, { name: 'get_page_text', input: {} }, random, { name: 'get_page_text', input: {} }] })
  expect(await has(/^en\.wikipedia\.org$/), 'the site, under Web').toBeDefined()
  expect(await has(/^2 pages$/), 'one page per visit').toBeDefined()
  expect(await has(/^Browser$/), 'going to pages and reading them makes no connector row').toBeUndefined()
  await ui.press({ key: 'w:en.wikipedia.org' })
  expect(await has(/^browser {2}\/wiki\/Ithihasa$/), 'the page the step after the pane opened read').toBeDefined()
  expect(await has(/^browser {2}\/wiki\/Cobie_Sikkens$/), 'the page the redirect landed on').toBeDefined()
  expect(await has(/Special:Random/), 'not the address asked for').toBeUndefined()

  // A preview of the person's own app and a click are the browser's, not the web's.
  await callTool($ as never, clock, { tool: 'mcp__Claude_Browser__navigate', tool_use_id: 'v2', url: 'http://localhost:3000' })
  await callTool($ as never, clock, { tool: 'mcp__Claude_Browser__computer', tool_use_id: 'v3', action: 'left_click', coordinate: [10, 10] })
  expect(await has(/^Browser$/)).toBeDefined()
  expect(await has(/^2 calls$/)).toBeDefined()
  expect(await has(/^localhost$/), 'no site row for the preview').toBeUndefined()

  // Chrome's visits count too; with no answer to read, by the address asked for.
  await callTool($ as never, clock, { tool: 'mcp__claude-in-chrome__navigate', tool_use_id: 'v4', url: 'https://www.example.org/pricing', tabId: 1 })
  expect(await has(/^example\.org$/)).toBeDefined()
  await ui.press({ key: 'w:example.org' })
  expect(await has(/^chrome {2}\/pricing$/)).toBeDefined()
  expect(await has(/^Chrome$/), 'and make no connector row').toBeUndefined()
})

// 1.4.0: subagents with their creds, the context cost card, and the copied summary.
test('subagents with their creds, what loads into every message, and the copied summary', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    ...blank(),
    memory: ['C:\\Users\\test\\.claude\\CLAUDE.md'],
    memoryTokens: { 'C:\\Users\\test\\.claude\\CLAUDE.md': 1000 },
    mcpTools: [
      { name: 'mcp__github__list_issues', serverName: 'github', tokens: 3000, isLoaded: true },
      { name: 'mcp__github__create_issue', serverName: 'github', tokens: 2000, isLoaded: true },
      { name: `mcp__${ID_SERVER}__notion-search`, serverName: 'Notion', tokens: 4000, isLoaded: true },
      { name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 1500, isLoaded: false },
    ],
    usage: [
      // The subagent's one request, on Haiku 5.5. With no split reported, its writes went to the 5-minute
      // cache, as a subagent's do: (0.1 ÷ 4) × (1,000 + 1.25 × 10,000 + 5 × 2,000) = 587.5 creds.
      { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, model: 'claude-haiku-5-5' },
      // One main-chat request on Opus 5.5 that the cache served.
      { input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' },
    ],
    // The whole session by the ledger: $0.10, 25,000 creds.
    ledgerUsd: 0.1,
    delays: { ag1: 65_000 },
    answers: { ag1: { result: { status: 'completed', agentId: 'agent-ag1', agentType: 'Explore', resolvedModel: 'claude-haiku-5-5', totalDurationMs: 65_000, totalToolUseCount: 1, content: [] } } },
    copied: [],
    notices: [],
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  await callTool($ as never, clock, { tool: 'mcp__github__list_issues', tool_use_id: 'g1', query: 'crash' })

  // The Agent call starts, the engine spawns the subagent, and it makes one request and one call.
  const agentCall = $.tool.call({ tool: 'Agent', tool_use_id: 'ag1', description: 'Find the auth code', subagent_type: 'Explore', prompt: 'Find it' } as never)
  await clock.settle()
  await $.agent.spawn({ tool_use_id: 'ag1', prompt: 'Find it', description: 'Find the auth code', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await clock.settle()
  await step($ as never, { agentId: 'agent-ag1', model: 'claude-haiku-5-5' })
  await clock.settle()
  await callTool($ as never, clock, { tool: 'Read', tool_use_id: 'ag1-r1', agentId: 'agent-ag1', file_path: 'C:\\Users\\test\\src\\auth.ts' })
  expect(await has(/^Find the auth code$/), 'the subagent, while it runs').toBeDefined()
  expect(await has(/^Explore · Haiku 5\.5 · 1 tool · running/)).toBeDefined()
  expect(await has(/^≈588 creds$/), 'its creds, its writes at the 5-minute price').toBeDefined()
  await clock.advance(65_000)
  await agentCall
  await clock.settle()
  expect(await has(/^Explore · Haiku 5\.5 · 1 tool · 1m 05s$/), 'done, with how long it ran').toBeDefined()

  // A main-chat request: the main chat's creds come from the ledger, less the subagents'.
  await step($ as never, {})
  await clock.settle()
  expect(await has(/^Main chat/), 'the Subagents card shows no main-chat line').toBeUndefined()

  // What loads into every message: 10,300 tokens, 0.05 creds each when the cache serves them.
  expect(await has(/^≈515 a message$/), 'the card figure').toBeDefined()
  expect(await has(/^≈515 · ≈515 so far$/), 'every message, and so far').toBeDefined()
  expect(await has(/^≈215 · ≈215 so far$/), 'the unused part: Notion and both skills').toBeDefined()
  expect(await has(/^Notion$/), 'the claude.ai connector never called').toBeDefined()
  expect(await has(/^unused$/), 'tagged unused').toBeDefined()
  expect(await has(/^4\.0k tok · ≈200$/)).toBeDefined()
  expect(await has(/^1 more connector loads its tools only when/), 'a connector whose tools wait for a search').toBeDefined()
  expect(await has(/^auto · 1\.0k tok$/), 'the memory file, with its tokens').toBeDefined()

  // Copy: the clipboard, else a notice Claude never reads; /chat-monitor copy does the same.
  await ui.press({ key: 'copy' })
  const copied = world.copied![0] ?? ''
  expect(copied).toContain('# Chat monitor')
  expect(copied).toContain('- **GitHub**: 1 call')
  expect(copied).toContain('- **Find the auth code**: Explore, Haiku 5.5, 1m 05s, 1 tool call, ≈588 creds')
  expect(copied.includes('Main chat'), 'nor does the summary').toBe(false)
  expect(copied).toContain('  - Notion (never called): 4.0k tokens, ≈200 a message')
  world.clipboard = false
  await ui.press({ key: 'copy' })
  expect(world.notices![0] ?? '', 'no clipboard: the summary is a notice').toContain('# Chat monitor')
  world.clipboard = true
  const out = (await $.command.run({ command: 'chat-monitor', args: 'copy' } as never)) as { text?: string }
  expect(out.text, '/chat-monitor copy answers in one short line').toBe('Copied a summary of this chat.')
  expect(world.copied!.length).toBe(2)
})

// 1.5.1: a subagent's cache writes are priced by the cache they went to.
test('a subagent\'s cache writes are priced by the cache the API says they went to', { timeoutMs: 30_000 }, async ($, on) => {
  const done = (id: string, agentType: string, model: string) => ({ result: { status: 'completed', agentId: `agent-${id}`, agentType, resolvedModel: model, totalDurationMs: 10_000, totalToolUseCount: 0, content: [] } })
  const world: World = {
    ...blank(),
    usage: [
      // A browser subagent's two requests on Opus 5.5, writing to the 5-minute cache:
      // 2 + 1.25 × 48,543 + 5 × 155 = 61,456, then 2 + 0.05 × 48,543 + 1.25 × 4,891 + 5 × 185 = 9,468.
      { input_tokens: 2, output_tokens: 155, cache_read_input_tokens: 0, cache_creation_input_tokens: 48_543, cache_creation: { ephemeral_5m_input_tokens: 48_543, ephemeral_1h_input_tokens: 0 }, model: 'claude-opus-5-5' },
      { input_tokens: 2, output_tokens: 185, cache_read_input_tokens: 48_543, cache_creation_input_tokens: 4_891, cache_creation: { ephemeral_5m_input_tokens: 4_891, ephemeral_1h_input_tokens: 0 }, model: 'claude-opus-5-5' },
      // A subagent whose writes the API says went to the 1-hour cache: (0.1 ÷ 4) × (1,000 + 2 × 10,000 + 5 × 2,000) = 775.
      { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }, model: 'claude-haiku-5-5' },
    ],
    delays: { a1: 10_000, a2: 10_000 },
    answers: { a1: done('a1', 'general-purpose', 'claude-opus-5-5'), a2: done('a2', 'Explore', 'claude-haiku-5-5') },
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  // One subagent: its Agent call, its spawn, its requests, then its end.
  const run = async (id: string, description: string, subagentType: string, model: string, requests: number) => {
    const call = $.tool.call({ tool: 'Agent', tool_use_id: id, description, subagent_type: subagentType, prompt: 'Go' } as never)
    await clock.settle()
    await $.agent.spawn({ tool_use_id: id, prompt: 'Go', description, subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
    await clock.settle()
    for (let i = 0; i < requests; i += 1) {
      await step($ as never, { agentId: `agent-${id}`, model })
      await clock.settle()
    }
    await clock.advance(10_000)
    await call
    await clock.settle()
  }
  await run('a1', 'Browser Wikipedia fact', 'general-purpose', 'claude-opus-5-5', 2)
  await run('a2', 'Cached for an hour', 'Explore', 'claude-haiku-5-5', 1)
  expect(await has(/^≈71k creds$/), 'the 5-minute writes at 1.25 times the input price: ≈71k, not ≈111k').toBeDefined()
  expect(await has(/^≈775 creds$/), 'the 1-hour writes at twice the input price').toBeDefined()
})

// 1.6.0: the Session card, worked out from the chat's transcript and its subagents' transcripts.
const stampAt = (time: string) => `2026-11-16T${time}.000Z`
const human = (time: string, content: unknown) => ({ type: 'user', timestamp: stampAt(time), origin: { kind: 'human' }, message: { role: 'user', content } })
const toolResult = (time: string, id: string) => ({ type: 'user', timestamp: stampAt(time), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const request = (time: string, id: string, used: [number, number, number, number, '1h' | '5m'], blocks: unknown[] = [{ type: 'text', text: 'Done.' }]) => {
  const [input, write, read, output, cache] = used
  const usage = { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, cache_creation: { [`ephemeral_${cache}_input_tokens`]: write } }
  return { type: 'assistant', timestamp: stampAt(time), message: { id, model: 'claude-opus-5-5', usage, content: blocks } }
}
const turnEnd = (time: string) => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: stampAt(time) })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')

test('the Session card: total spent, time, activity, cache hit rate, where creds went, cold sends, priciest prompt and average', { timeoutMs: 30_000 }, async ($, on) => {
  const folder = 'C:/Users/test/.claude/projects/C--Users-test-projects-My-App'
  const transcript = `${folder}/session-1.jsonl`
  const subagents = `${folder}/session-1/subagents`
  // Opus 5.5 creds: new input + 0.05 × read + (2 × a 1-hour write | 1.25 × a 5-minute one) + 5 × output.
  const main = [
    human('09:00:00', [{ type: 'text', text: '<system-reminder>The folder is empty.</system-reminder>' }, { type: 'text', text: 'hi' }]),
    // One request stored as two lines, each with its usage: counted once. 2 + 40,000 + 500 = 40,502.
    request('09:00:05', 'm1', [2, 20_000, 0, 100, '1h'], [{ type: 'thinking', thinking: '' }]),
    request('09:00:05', 'm1', [2, 20_000, 0, 100, '1h'], [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
    toolResult('09:00:06', 'tu1'),
    // 2 + 1,000 + 1,000 + 1,000 = 3,002.
    request('09:00:10', 'm2', [2, 500, 20_000, 200, '1h']),
    turnEnd('09:00:11'),
    // A slash command answered locally: a turn with no request, so no prompt.
    human('09:01:00', '<command-name>/chat-monitor</command-name>'),
    human('09:10:00', 'Yes, fix it'),
    // The cache gone: 21,002 sent, none of it read. A cold send: 2 + 42,000 + 1,500 = 43,502.
    request('09:10:04', 'm3', [2, 21_000, 0, 300, '1h'], [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: {} }]),
    toolResult('09:10:05', 'tu2'),
    // The subagent reports back: a turn of its own, whose work counts to "Yes, fix it". 2 + 1,050.1 + 2,000 + 2,000 = 5,052.1.
    { type: 'user', isMeta: true, timestamp: stampAt('09:10:20'), origin: { kind: 'peer' }, message: { role: 'user', content: 'Another Claude session sent a message' } },
    request('09:10:25', 'm4', [2, 1_000, 21_002, 400, '1h']),
    turnEnd('09:10:26'),
  ]
  const sub = [
    // 2 + 60,678.75 + 775 = 61,455.75, then 2 + 2,427.15 + 6,113.75 + 925 = 9,467.9.
    request('09:10:10', 's1', [2, 48_543, 0, 155, '5m'], [{ type: 'tool_use', id: 'st1', name: 'Bash', input: {} }]),
    request('09:10:15', 's2', [2, 4_891, 48_543, 185, '5m']),
  ]
  const world: World = {
    ...blank(),
    files: { [transcript]: jsonl(main), [`${subagents}/agent-x.jsonl`]: jsonl(sub) },
    dirs: { [subagents]: ['agent-x.jsonl'] },
    reads: [],
    // $0.70 by the ledger: 175,000 creds.
    ledgerUsd: 0.7,
    startedAt: Date.parse(stampAt('09:00:00')),
    copied: [],
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  // The summary card: its label, the total large in creds and dollars, and where the total came from.
  expect(await has(/^session$/), 'the card').toBeDefined()
  expect(await has(/^≈175k$/), 'total spent, by the ledger').toBeDefined()
  expect(await has(/^\$0\.70$/), 'in dollars').toBeDefined()
  expect(await has(/^total from Claude Code$/), 'where the total came from').toBeDefined()
  // Turns of 11s, 0s (the slash command), 5s and 6s; the clock reads 09:30.
  expect(await has(/^open 30m 00s · working 22s$/), 'time').toBeDefined()
  expect(await has(/2 prompts · 6 requests · 3 tool calls$/), 'activity: subagents included').toBeDefined()
  // Of 162,981.75 creds: 4,477.25 reading, 151,792.5 writing, 6,700 output, 12 new input: the split's legend.
  expect(await has(/● reading 3%$/), 'where creds went: reading').toBeDefined()
  expect(await has(/● writing 93%$/), 'writing').toBeDefined()
  expect(await has(/● output 4%$/), 'output').toBeDefined()
  expect(await has(/new input/), 'under 1% is left out').toBeUndefined()
  // The tiles. 89,545 of 185,491 input tokens read from the cache.
  expect(await has(/^cache hits$/)).toBeDefined()
  expect(await has(/^48%$/), 'cache hit rate').toBeDefined()
  // The table's own figures, not scaled to the ledger's total. The cold send: 43,502.
  expect(await has(/^cold sends$/)).toBeDefined()
  expect(await has(/^≈44k creds$/), 'one cold send, what it cost').toBeDefined()
  // "Yes, fix it": 43,502 + 61,455.75 + 9,467.9 + 5,052.1 = 119,477.75, its subagent's work included.
  expect(await has(/^≈119k$/), 'the priciest prompt').toBeDefined()
  expect(await has(/“Yes, fix it”$/), 'by its words').toBeDefined()
  // 162,981.75 over 2 prompts.
  expect(await has(/^≈81k$/), 'the average per prompt').toBeDefined()
  expect(await has(/Priced by|to match it/), 'no scaling, so nothing to say about it').toBeUndefined()

  // Copy has them too.
  await ui.press({ key: 'copy' })
  const copied = world.copied![0] ?? ''
  expect(copied).toContain('## Session')
  expect(copied).toContain('- Total spent: ≈175k creds · $0.70')
  expect(copied).toContain('- Priciest prompt: ≈119k creds, “Yes, fix it”')
  expect(copied.includes('Priced by'), 'nor does the summary').toBe(false)

  // A reload with nothing new reads no transcript; one more prompt is counted once the transcript has it.
  const reads = () => world.reads!.filter(path => path === transcript).length
  expect(reads(), 'read once').toBe(1)
  await start($ as never, 'desktop')
  await clock.settle()
  expect(reads(), 'unchanged: not read again').toBe(1)
  world.files![transcript] = jsonl([...main, human('09:20:00', 'thanks'), request('09:20:03', 'm5', [2, 100, 22_002, 50, '1h'])])
  await start($ as never, 'desktop')
  await clock.settle()
  expect(reads(), 'changed: read again').toBe(2)
  expect(await has(/3 prompts · 7 requests · 3 tool calls$/), 'the new prompt counted').toBeDefined()
})

// 1.7.0: each skill's creds: its instructions while the context carried them, its skill-list line, and its turns.
test('each skill shows its creds: instructions carried, its skill-list line, and the turns that used it', { timeoutMs: 30_000 }, async ($, on) => {
  const folder = 'C:/Users/test/.claude/projects/C--Users-test-projects-My-App'
  const transcript = `${folder}/session-1.jsonl`
  const subagents = `${folder}/session-1/subagents`
  // About four characters to a token: 2,000 tokens of code-review, 1,000 of deploy, 500 of deploy read by a subagent.
  const reviewBody = 'Base directory for this skill: C:/skills/code-review\n'.padEnd(8000, 'r')
  const deployBody = 'd'.repeat(4000)
  const meta = (time: string, parts: Record<string, unknown>, text: string) => ({ type: 'user', isMeta: true, timestamp: stampAt(time), ...parts, message: { role: 'user', content: [{ type: 'text', text }] } })
  const main = [
    human('09:00:00', 'review my code'),
    // 2 + 2 × 10,000 + 5 × 100 = 20,502. The Skill call; nothing before it was sent but this request's 10,002.
    request('09:00:05', 'm1', [2, 10_000, 0, 100, '1h'], [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } }]),
    toolResult('09:00:06', 'sk1'),
    meta('09:00:06', { sourceToolUseID: 'sk1' }, reviewBody),
    // The first request after the load writes the 2,000 tokens: 2 × 2,000 = 4,000. Its own creds: 5,702.1.
    request('09:00:10', 'm2', [2, 2_100, 10_002, 200, '1h']),
    turnEnd('09:00:11'),
    human('09:05:00', 'thanks'),
    // Read as far as 12,104, past where the instructions end (12,002): 0.05 × 2,000 = 100.
    request('09:05:03', 'm3', [2, 100, 12_104, 50, '1h']),
    turnEnd('09:05:04'),
    // A skill typed as a slash command: its instructions are the note after the command.
    { ...human('09:10:00', '<command-name>/deploy</command-name>'), uuid: 'u-deploy' },
    meta('09:10:00', { parentUuid: 'u-deploy', uuid: 'u-deploy-body' }, deployBody),
    // code-review read again (100); deploy written (2 × 1,000 = 2,000). Its own creds: 3,112.3.
    request('09:10:05', 'm4', [2, 1_050, 12_206, 80, '1h']),
    turnEnd('09:10:06'),
    // A compaction drops both; the engine attaches code-review again, which the next request writes: 4,000.
    { type: 'system', subtype: 'compact_boundary', timestamp: stampAt('09:20:00') },
    { type: 'attachment', timestamp: stampAt('09:20:01'), attachment: { type: 'invoked_skills', skills: [{ name: 'code-review', path: 'x', content: reviewBody }] } },
    human('09:20:02', 'go on'),
    request('09:20:05', 'm5', [2, 9_000, 0, 50, '1h']),
    turnEnd('09:20:06'),
  ]
  const sub = [
    // A subagent in the deploy turn reads deploy's SKILL.md (500 tokens) and writes it to the 5-minute cache: 1.25 × 500 = 625.
    // Its requests cost 727 and 877.1, which count to the deploy turn.
    request('09:10:02', 's1', [2, 500, 0, 20, '5m'], [{ type: 'tool_use', id: 'sr1', name: 'Read', input: { file_path: 'C:\\Users\\test\\.claude\\skills\\deploy\\SKILL.md' } }]),
    { type: 'user', timestamp: stampAt('09:10:03'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sr1', content: 'y'.repeat(2000) }] } },
    request('09:10:04', 's2', [2, 600, 502, 20, '5m']),
  ]
  const world: World = {
    ...blank(),
    uses: [{ tool_use_id: 'sk1', tool: 'Skill', input: { skill: 'code-review' } }],
    typed: '<command-name>/deploy</command-name>',
    files: { [transcript]: jsonl(main), [`${subagents}/agent-x.jsonl`]: jsonl(sub) },
    dirs: { [subagents]: ['agent-x.jsonl'] },
    // One live main-chat request the cache served: each skill's listing at 0.05 creds a token, 5 and 10.
    usage: [{ input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }],
    copied: [],
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  await step($ as never, {})
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  // code-review: 4,000 + 100 + 100 + 4,000 carried, and 5 for its line. deploy: 2,000 + 625, and 10.
  expect(await has(/^≈8\.2k creds$/), 'code-review, its instructions and listing').toBeDefined()
  expect(await has(/^≈2\.6k creds$/), 'deploy, the subagent\'s load included').toBeDefined()
  expect(await has(/^2 · ≈11k creds$/), 'the card figure: both together').toBeDefined()
  expect(await has(/^1 use · 2\.0k tok$/), 'its uses and size under its name').toBeDefined()
  expect(await has(/^1 use · 1\.0k tok$/), 'the larger of deploy\'s loads').toBeDefined()

  // A press on a skill shows what its creds paid for; a second press hides it.
  expect(await has(/Skill list line/), 'folded at first').toBeUndefined()
  await ui.press({ key: 's:code-review' })
  expect(await has(/2\.0k tok · 2 loads · 4 requests · ≈8\.2k$/), 'two loads, the compaction\'s included, over four requests').toBeDefined()
  expect(await has(/^100 tok · ≈5$/), 'its line in the skill list').toBeDefined()
  // "review my code": 20,502 + 5,702.1; the compaction's reload is no use, so "go on" is not its turn.
  expect(await has(/^1 turn · ≈26k$/), 'the turn it was used in').toBeDefined()
  expect(await has(/^A turn counts all its work/), 'what a turn\'s figure holds').toBeDefined()
  await ui.press({ key: 's:code-review' })
  expect(await has(/Skill list line/)).toBeUndefined()

  // The Context cost card's skill list shows what each line has cost so far.
  await ui.press({ key: 'skills-list' })
  expect(await has(/^200 tok · ≈10 so far$/), 'deploy\'s line so far').toBeDefined()

  // Copy has them too. deploy's turn: 3,112.3 + 727 + 877.1, its subagent's work included.
  await ui.press({ key: 'copy' })
  const copied = world.copied![0] ?? ''
  expect(copied).toContain('- /code-review (1 use): ≈8.2k creds (instructions ≈8.2k, skill list ≈5); the turn it was used in ≈26k')
  expect(copied).toContain('- /deploy (1 use): ≈2.6k creds (instructions ≈2.6k, skill list ≈10); the turn it was used in ≈4.7k')
})

// 1.8.0: transcripts are read from where the last read stopped, in pieces under the engine's 4 MiB a read.
test('a transcript is read in pieces from where the last read stopped, a line longer than a piece included', { timeoutMs: 60_000 }, async ($, on) => {
  const folder = 'C:/Users/test/.claude/projects/C--Users-test-projects-My-App'
  const transcript = `${folder}/session-1.jsonl`
  const request1h = (time: string, id: string, blocks?: unknown[]) => request(time, id, [2, 100, 1000, 10, '1h'], blocks)
  // About 100 KB a line, of two-byte characters, so pieces cut characters in two.
  const long = [{ type: 'text', text: 'é'.repeat(50_000) }]
  const main = [
    human('09:00:00', 'hi'),
    request1h('09:00:01', 'r1', [{ type: 'tool_use', id: 'tu-big', name: 'Read', input: {} }]),
    ...Array.from({ length: 7 }, (_, i) => request1h(`09:00:0${i + 2}`, `r${i + 2}`, long)),
    // One line of 2.2 MB, longer than a piece: it spans two reads. It is the turn's last sign of work.
    { type: 'user', timestamp: stampAt('09:01:00'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-big', content: 'ü'.repeat(1_100_000) }] } },
    ...Array.from({ length: 4 }, (_, i) => request1h(`09:00:${10 + i}`, `r${i + 9}`, long)),
  ]
  const world: World = { ...blank(), files: { [transcript]: jsonl(main) }, reads: [] }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  const reads = () => world.reads!.filter(path => path === transcript).length

  expect(utf8.encode(world.files![transcript]!).length, 'over one piece of 2 MiB').toBeGreaterThan(2 * 1024 * 1024)
  expect(await has(/(^|\s)1 prompt · 12 requests · 1 tool call$/), 'every line, the long one too').toBeDefined()
  expect(await has(/working 1m 00s$/), 'the long line parsed whole: its time ends the turn').toBeDefined()
  expect(reads(), 'two pieces').toBe(2)

  // The chat goes on: only what was added is read, and nothing is counted twice.
  world.files![transcript] = jsonl([...main, human('09:40:00', 'more'), request1h('09:40:02', 'r13')])
  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/(^|\s)2 prompts · 13 requests · 1 tool call$/), 'the new prompt, once').toBeDefined()
  expect(reads(), 'one more piece').toBe(3)

  // A transcript that got shorter was written anew: read again from the start.
  world.files![transcript] = jsonl([human('10:00:00', 'fresh start'), request1h('10:00:02', 'z1')])
  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/(^|\s)1 prompt · 1 request · 0 tool calls$/), 'only what it holds now').toBeDefined()
})

// 1.9.0: Claude Code's own figures come first; the table only splits them.
test('a subagent shows Claude Code\'s own cost for it once Claude Code has one', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    ...blank(),
    // By the table: (0.1 ÷ 4) × (1,000 + 1.25 × 10,000 + 5 × 2,000) = 587.5 creds.
    usage: [{ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, model: 'claude-haiku-5-5' }],
    delays: { ag1: 1_000 },
    answers: { ag1: { result: { status: 'completed', agentId: 'agent-ag1', agentType: 'Explore', resolvedModel: 'claude-haiku-5-5', totalDurationMs: 1_000, totalToolUseCount: 0, content: [] } } },
    copied: [],
  }
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

  const call = $.tool.call({ tool: 'Agent', tool_use_id: 'ag1', description: 'Find the auth code', subagent_type: 'Explore', prompt: 'Find it' } as never)
  await clock.settle()
  await $.agent.spawn({ tool_use_id: 'ag1', prompt: 'Find it', description: 'Find the auth code', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await clock.settle()
  await step($ as never, { agentId: 'agent-ag1', model: 'claude-haiku-5-5' })
  await clock.settle()
  await clock.advance(1_000)
  await call
  await clock.settle()
  expect(await has(/^≈588 creds$/), 'the table\'s count, while Claude Code has no figure').toBeDefined()

  // Claude Code's own estimate for it: $0.003, 750 creds. It replaces the table's count.
  world.agents = [{ id: 'agent-ag1', cost: { usd: 0.003 } }]
  await start($ as never, 'desktop')
  await clock.settle()
  expect(await has(/^≈750 creds$/), 'Claude Code\'s figure').toBeDefined()
  expect(await has(/^≈588 creds$/)).toBeUndefined()
  await ui.press({ key: 'copy' })
  expect(world.copied![0] ?? '').toContain('- **Find the auth code**: Explore, Haiku 5.5, 1.0s, 0 tool calls, ≈750 creds')
})

// 1.11.0: the redesigned pane.
test('a list sorts by its dropdown, a card folds by its arrow too, and an empty section says what will show there', { timeoutMs: 30_000 }, async ($, on) => {
  const world = fresh()
  const clock = engine(on as never, world)
  await start($ as never, 'desktop')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'chat-monitor', surface: 'desktop', component: 'Pane', requestId: 'chat-monitor', props })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
  const names = async () => (await ui.findAll({ type: 'Text', text: /^(GitHub|Connector 1a59)$/ })).map(one => one.text)

  // Newest first, then by calls, then by name.
  expect(await names(), 'newest first').toEqual(['Connector 1a59', 'GitHub'])
  await ui.select({ key: 'sort-connectors', value: 'most calls' })
  expect(await names(), 'most calls first').toEqual(['GitHub', 'Connector 1a59'])
  await ui.select({ key: 'sort-connectors', value: 'a to z' })
  expect(await names(), 'by name').toEqual(['Connector 1a59', 'GitHub'])

  // The arrow folds a card as its label does, and opens it again.
  await ui.press({ key: 'fold-connectors' })
  expect(await names(), 'folded').toEqual([])
  await ui.press({ key: 'fold-connectors' })
  expect((await names()).length, 'open again').toBe(2)

  // Small monospace labels over each section; tags on the files; a placeholder where nothing is yet.
  expect(await has(/^connectors$/)).toBeDefined()
  expect(await has(/^edited$/), 'the edited file is tagged').toBeDefined()
  expect(await has(/^None started yet\. Subagents show here/), 'the empty subagents section says what goes there').toBeDefined()
  // Tiles for each row: GitHub's logo, the skill's slash.
  const tiles = (await ui.findAll({ type: 'Svg' })).map(one => (one.props as { alt?: string }).alt)
  expect(tiles, 'the connector tiles').toContain('GitHub')
  expect(tiles, 'a skill tile').toContain('skill')
})
