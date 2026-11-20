import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const START = Date.UTC(2026, 10, 16, 9, 0)
const MIN = 60_000
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: number
  context?: { tokens?: number; window: number }
  compactAt?: number
  notes?: string[]
  runs?: string[][]
  compacted?: number
  /** $.session.compact rejects, as in a -p run or an SDK host. */
  compactRefused?: boolean
  /** $.command.run rejects too. */
  commandRefused?: boolean
  commands?: string[]
  toasts?: string[]
  /** The fork's answers, in order: a readback, or a failure as the engine gives it. Warm once they run out. */
  forks?: ({ read: number; write: number } | { isAnswered: false; reason: string; status?: number | null; error?: string; usage?: unknown })[]
  forked?: number
  /** What each ping adds to Claude Code's cost, in dollars, where there is a ledger. */
  pingUsd?: number
  logs?: string[]
  model?: string
  /** Every status line the band pinned, in order; undefined where it took it away. */
  status?: (string | undefined)[]
  /** The band's own store, as the engine keeps it across restarts. */
  store?: Record<string, unknown>
  /** Prompts the chat had before this process began. */
  turns?: number
  /** What a full /context count comes to. Set, a compaction empties the fill, as Claude Code does until the next reply. */
  counted?: number
}

// Stands in for the engine: every call the mod makes on `$` is answered from `world`.
function engine(on: On, world: World) {
  world.notes ??= []
  world.runs ??= []
  world.compacted ??= 0
  world.commands ??= []
  world.toasts ??= []
  world.forked ??= 0
  world.logs ??= []
  const store = (world.store ??= {})
  on('store.get', async ($, e) => ({ value: store[(e as { key: string }).key] }) as never)
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store[key] = value
    return { value: undefined } as never
  })
  on('store.delete', async ($, e) => {
    delete store[(e as { key: string }).key]
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: Object.keys(store) }) as never)
  on('session.turns', async () => ({ value: world.turns ?? 0 }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('session.id', async () => ({ value: 'S1' }) as never)
  on('session.model', async () => ({ value: world.model ?? 'claude-opus-5-5' }) as never)
  on('command.register', async ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.log', async ($, e) => {
    world.logs!.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  world.status ??= []
  on('ui.status', async ($, e) => {
    world.status!.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('model.fork', async () => {
    world.forked! += 1
    if (world.pingUsd && world.cost !== undefined) world.cost += world.pingUsd
    const answer = world.forks?.shift() ?? { read: 200_000, write: 0 }
    if ('isAnswered' in answer) return { value: { usage: zero, ...answer } } as never
    const usage = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: answer.read, cache_creation_input_tokens: answer.write }
    return { value: { isAnswered: true, text: 'warm', usage } } as never
  })
  on('session.usage', async ($, e) => {
    const context = world.context ?? { tokens: 1000, window: 200_000 }
    const asked = (e as { breakdown?: string } | undefined)?.breakdown
    const breakdown =
      world.compactAt || (asked === 'full' && world.counted)
        ? { isAutoCompactEnabled: !!world.compactAt, autoCompactThreshold: world.compactAt ?? 0, ...(asked === 'full' && world.counted ? { totalTokens: world.counted } : {}) }
        : undefined
    return { value: { startedAt: START, context: { ...context, breakdown }, rateLimits: world.limits, ...(world.cost === undefined ? {} : { cost: { usd: world.cost } }) } } as never
  })
  on('session.measure', async ($, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  const compact = () => {
    world.compacted! += 1
    if (world.counted) world.context = { window: (world.context ?? { window: 200_000 }).window }
  }
  // Left unanswered, a call reaches the kit's bottom hook, which throws: the caller's promise rejects,
  // as the engine's refusal does.
  if (!world.compactRefused) {
    on('session.compact', async () => {
      compact()
      return { messages: [{ role: 'user', text: 'Summary of the chat so far.', toolUses: [] }] } as never
    })
  }
  if (!world.commandRefused) {
    on('command.run', async ($, e) => {
      const command = (e as { command: string }).command
      world.commands!.push(command)
      if (command === 'compact') compact()
      return { text: '' } as never
    })
  }
  on('classic.PostModelSwitch', async () => ({}) as never)
  on('turn.start', async ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async () => ({ result: {} }) as never)
  on('ui.notify', async ($, e) => {
    world.notes!.push((e as { text: string }).text)
    return { value: {} } as never
  })
  on('ui.toast', async ($, e) => {
    world.toasts!.push((e as { text: string }).text)
    return { value: {} } as never
  })
  on('process.run', async ($, e) => {
    world.runs!.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  return mock.clock(on, { now: START })
}

/** One model request of the turn, answered with the given usage by the given model. */
function step(on: On, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, model = 'claude-opus-5-5') {
  on('turn.step', async function* ($, e) {
    const asked = e as { turnId: string; index: number }
    return { turnId: asked.turnId, index: asked.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model } } as never
  } as never)
}

/** Sends one model request through the hooks, reading its stream to the end. */
async function request($: { turn: { step: (input: never) => unknown } }, turnId: string, index: number) {
  const stream = (await $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 + 2 * index } as never)) as AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }
  for await (const _ of stream) {
    // The chunks are not needed; reading them lets the step finish.
  }
  return stream.result
}

const props = { isWorking: false, hasSurvey: false, isCollapsed: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never

/** What the band draws hidden until the pointer is on its part: the hover tips. */
async function hiddenOf(band: { findAll: (q: object) => Promise<unknown[]> }) {
  const boxes = (await band.findAll({ type: 'Box' })) as { props: { display?: string }; text?: string }[]
  return boxes.filter(one => one.props.display === 'none').map(one => one.text ?? '')
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the band follows a prompt's work, the 5-hour limit and the cache (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
    const world: World = { limits: [{ kind: 'seven_day', percentUsed: 12 }, { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(START + 130 * MIN).toISOString() }] }
    const clock = engine(on as never, world)
    const texts = async () => {
      const band = await $.ui.mount({ plugin: 'taskband', surface, component: 'AbovePrompt', props })
      const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
      await band.unmount()
      return all
    }

    await $.session.start({ source: 'startup', cwd: 'C:\\work', surface, isInteractive: true } as never)
    let seen = await texts()
    expect(seen, 'before any prompt').toContain('Waiting for a prompt')
    expect(seen, 'the limit is read at the start').toContain('34%')
    // The reset time is left to the details, on every surface.
    expect(seen, 'the reset time is left to the details').not.toContain('2h 10m')
    expect(seen, 'no request yet').toContain('not started')

    // A prompt with no to-do list: time so far.
    await $.turn.start({ text: 'fix the bug', turnId: 't1' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'a1', file_path: 'C:\\work\\a.ts' } as never)
    await clock.advance(75_000)
    seen = await texts()
    expect(seen).toContain('Working')
    expect(seen, 'elapsed').toContain('1m 15s')
    expect(seen, 'the cache counts down from the last request').toContain('59m')

    // A to-do list arrives and moves on.
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a2', items: [{ content: 'Read the code', status: 'in_progress' }, { content: 'Write the fix', status: 'pending' }, { content: 'Run the tests', status: 'pending' }] } as never)
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a3', advance: true } as never)
    seen = await texts()
    expect(seen, 'the running step').toContain('Write the fix')
    expect(seen, 'steps done').toContain('1/3')

    // The limit moves; past 70% it is flagged.
    await $.session.measure({ context: { tokens: 1000, window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 81.5, resetsAt: new Date(START + 130 * MIN).toISOString() }], changed: ['rateLimits'] } as never)
    expect(await texts()).toContain('82%')

    // The turn ends with every step done.
    // Wrapping up checks off the whole list, the step that never started included.
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', tool_use_id: 'a4', recap: 'Done.' } as never)
    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    seen = await texts()
    expect(seen).toContain('All tasks done')
    expect(seen).toContain('3/3')

    // The last ten minutes count in seconds; after the hour the cache is cold.
    await clock.advance(55 * MIN)
    expect(await texts(), 'near the end').toContain('5:00')
    await clock.advance(6 * MIN)
    expect(await texts(), 'past the hour').toContain('cold')

    // A new prompt clears a finished list and warms the cache again.
    await $.turn.start({ text: 'now the docs', turnId: 't2' } as never)
    seen = await texts()
    expect(seen).toContain('Working')
    expect(seen, 'the finished list is gone').not.toContain('3/3')
    // The cache counts in minutes: a new prompt sets it back to 60m, never "1h 00m".
    expect(seen, 'a full hour again').toContain('60m')
    expect(seen, 'in minutes').not.toContain('1h 00m')

    // Once its window has passed, the limit reads as reset.
    await clock.advance(80 * MIN)
    expect(await texts()).toContain('reset')
  })
}

test('the tokens of this prompt follow the timer, and a long turn rings when it ends', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [] }
  const clock = engine(on as never, world)
  step(on as never, { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await request($ as never, 't1', 0)
  await request($ as never, 't1', 1)
  await clock.advance(30_000)
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  await band.unmount()
  // Each request on Opus 5.5: 1.2k new + 0.05 × 40k read + 2 × 2k write + 5 × 800 out = 11.2k weighted.
  expect(all, 'two requests: 22k creds').toContain('30s · 22k creds')

  // A short turn ends quietly; a long one rings.
  await $.turn.complete({ answer: 'ok', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  expect(world.runs, 'no chime after 30 seconds').toHaveLength(0)
  await $.turn.start({ text: 'and more', turnId: 't2' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 95_000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await clock.settle()
  expect(world.runs, 'a chime after a minute and a half').toHaveLength(1)
  expect(world.runs![0]![0]).toBe('powershell.exe')
  // A turn the person stopped does not ring.
  await $.turn.start({ text: 'once more', turnId: 't3' } as never)
  await $.turn.complete({ answer: '', durationMs: 120_000, isAborted: true, turnId: 't3', reason: 'aborted' } as never)
  await clock.settle()
  expect(world.runs).toHaveLength(1)
})

test('This turn puts the creds with the dollars and the calls, and the raw tokens before the limits', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [], cost: 1.5 })
  step(on as never, { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await request($ as never, 't1', 0)
  await request($ as never, 't1', 1)
  await $.session.measure({ cost: { usd: 1.62 }, changed: ['cost'] } as never)
  await clock.advance(30_000)
  const all = await detailsOf($ as never)
  // $0.12 is 30k creds; the two requests read, wrote and sent back 44k tokens each.
  expect(all, 'the main row counts creds').toContain('30s · 30k creds')
  expect(all, 'This turn').toMatch(/30k \| creds · \$0\.12 · 0 tool calls \| 88k tokens/)
})

test('the cache turns red in its last five minutes and, with the notice on, sends one', { options: { cacheAlert: 'on' }, timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'hello', turnId: 't1' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(50 * MIN)
  expect(world.notes, 'ten minutes left: no notice').toHaveLength(0)
  await clock.advance(5 * MIN + 2000)
  await clock.settle()
  expect(world.notes, 'one notice').toHaveLength(1)
  expect(world.notes![0]).toContain('goes cold in 5 minutes')
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  const value = await band.find({ type: 'Text', text: /^4:5\d$/ })
  expect(value?.props.color, 'the countdown is red').toBe('error')
  // On the desktop the dot is a picture that fades down and back up by itself.
  const dot = (await band.findAll({ type: 'Svg' })).find(one => (one.props as { alt?: string }).alt === 'the cache is in its last five minutes')
  expect((dot?.props as { source?: string } | undefined)?.source, 'the fading dot').toContain('<animate attributeName="opacity" values="1;0.25;1"')
  await band.unmount()
  // The terminal, which draws no pictures, blinks a text dot with each second's redraw.
  const text = await $.ui.mount({ plugin: 'taskband', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await text.find({ type: 'Text', text: '●' }), 'the blinking dot').toBeDefined()
  await text.unmount()
  await clock.advance(60_000)
  await clock.settle()
  expect(world.notes, 'still one notice').toHaveLength(1)
})

test('the chevron opens the step list, both limits, the cost and the context, and Compact asks first', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    limits: [
      { kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(START + 3 * 24 * 60 * MIN).toISOString() },
    ],
    cost: 1.5,
    context: { tokens: 150_000, window: 200_000 },
    compactAt: 167_000,
  }
  const clock = engine(on as never, world)
  step(on as never, { input_tokens: 500, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a1', items: [{ content: 'Put the full text in the new chat so nothing is lost on the way', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] } as never)
  await request($ as never, 't1', 0)
  // During the turn the 5-hour limit rises from 25% to 28.4% and the 7-day one from 12% to 12.6%.
  const during = [
    { kind: 'five_hour', percentUsed: 28.4, resetsAt: world.limits[0]!.resetsAt },
    { kind: 'seven_day', percentUsed: 12.6, resetsAt: world.limits[1]!.resetsAt },
  ]
  await $.session.measure({ context: { tokens: 150_000, window: 200_000 }, rateLimits: during, cost: { usd: 1.92 }, changed: ['cost', 'rateLimits'] } as never)

  const tall = { ...(props as object), maxRows: 40 } as never
  const mount = () => $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: tall })
  let band = await mount()
  expect((await band.findAll({ type: 'Text' })).map(one => one.text).join(' | '), 'closed: no details').not.toContain('7d')
  await band.press({ key: 'more' })
  await band.unmount()

  band = await mount()
  let all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  expect(all, 'the running step in full').toContain('Put the full text in the new chat so nothing is lost on the way')
  expect(all, 'the other step').toContain('Test it')
  expect(all, 'no repeated title or count').not.toContain('0 of 2 done')
  expect(
    (await band.findAll({ type: 'Text' })).filter(one => one.text === 'Put the full text in the new chat so nothing is lost on the way'),
    'once on the row, once as the running step: no heading in between',
  ).toHaveLength(2)
  expect(all, 'the weekly limit').toContain('7d')
  expect(all).toContain('13%')
  expect(all, 'exact reset times').toMatch(/resets .*· in 2h 56m/)
  // Claude Code's ledger moved $0.42: 105k creds at $4 per million, whatever the table says.
  expect(all, 'the creds, from the cost').toContain('105k')
  expect(all, 'how far each limit moved this turn').toContain('10k tokens · 5h +3.4% · 7d +0.6%')
  expect(all, 'no tokens by kind').not.toContain('cache read')
  expect(all, 'the creds lead, the cost of this prompt follows').toMatch(/creds · \$0\.42 · 1 tool call/)
  expect(all, 'no line about compacting later').not.toContain('Compact after this turn')
  expect(all, 'the context fill').toContain('75%')
  expect(all, 'where it compacts').toContain('compacts at 84%')
  expect(await band.find({ key: 'compact' }), 'no Compact while the turn runs').toBeUndefined()
  await band.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  // The context pill's width, read off its picture.
  const contextPill = async () =>
    ((await band.findAll({ type: 'Svg' })).find(one => String((one.props as { alt?: string }).alt).includes('context window'))?.props as { width?: number } | undefined)?.width
  band = await mount()
  const restingWidth = await contextPill()
  expect(restingWidth, 'the pill is drawn').toBeGreaterThan(0)
  await band.press({ key: 'compact' })
  await band.unmount()
  band = await mount()
  all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  expect(all, 'asks first').toContain('Compact now?')
  expect(all, 'the line under the figure stays').toContain('150k of 200k')
  expect(await band.find({ key: 'compact' }), 'the question stands in the button\'s place').toBeUndefined()
  expect(await band.find({ key: 'compact-yes' }), 'Yes where the button was').toBeDefined()
  expect(await band.find({ key: 'compact-no' }), 'No beside it').toBeDefined()
  expect(await band.find({ key: 'week-q' }), 'two across, the question stands on the 7d limit\'s pill line, over Yes and No').toBeDefined()
  expect(await band.find({ key: 'cqt' }), 'not beside the buttons as well').toBeUndefined()
  expect(await contextPill(), 'the context pill keeps its width while it asks').toBe(restingWidth)
  await band.press({ key: 'compact-no' })
  await band.unmount()
  expect(world.compacted, 'No compacts nothing').toBe(0)

  band = await mount()
  await band.press({ key: 'compact' })
  await band.unmount()
  band = await mount()
  await band.press({ key: 'compact-yes' })
  await band.unmount()
  await clock.settle()
  expect(world.compacted, 'Yes compacts once').toBe(1)
  band = await mount()
  expect(await band.find({ key: 'compact' }), 'back at rest').toBeDefined()
  await band.unmount()
})

// The desktop app's Code tab runs Claude Code through the SDK, where $.session.compact is refused:
// compaction there runs inside a turn, as a /compact prompt.
for (const commandRefused of [false, true]) {
  test(`where $.session.compact is refused, Yes runs /compact${commandRefused ? ', and says to type it when that fails too' : ''}`, { timeoutMs: 30_000 }, async ($, on) => {
    const world: World = { limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() }], compactRefused: true, commandRefused }
    const clock = engine(on as never, world)
    await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
    await clock.settle()
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await $.turn.complete({ answer: 'ok', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    const tall = { ...(props as object), maxRows: 40 } as never
    const mount = () => $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: tall })
    let band = await mount()
    await band.press({ key: 'more' })
    await band.unmount()
    band = await mount()
    await band.press({ key: 'compact' })
    await band.unmount()
    band = await mount()
    await band.press({ key: 'compact-yes' })
    await band.unmount()
    await clock.settle()
    expect(world.toasts!.join(' | '), 'never a raw engine error').not.toContain('Could not compact')
    if (commandRefused) {
      expect(world.compacted, 'nothing compacted').toBe(0)
      expect(world.toasts, 'says how to compact').toContain('The band cannot compact this chat. Type /compact instead.')
    } else {
      expect(world.commands, 'the /compact command, once').toEqual(['compact'])
      expect(world.compacted, 'compacted once').toBe(1)
      expect(world.toasts).toContain('Chat compacted.')
    }
    band = await mount()
    expect(await band.find({ key: 'compact' }), 'back at rest').toBeDefined()
    await band.unmount()
  })
}

test('four across, with nothing above Context, the question stands on its label line', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() }, { kind: 'seven_day', percentUsed: 52 }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const wide = { ...(props as object), maxRows: 40, bodyColumns: 200 } as never
  const mount = () => $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: wide })
  let band = await mount()
  await band.press({ key: 'more' })
  await band.unmount()
  band = await mount()
  await band.press({ key: 'compact' })
  await band.unmount()
  band = await mount()
  expect(await band.find({ key: 'ctx-q' }), 'on the Context label line').toBeDefined()
  expect(await band.find({ key: 'week-q' }), 'not on the 7d limit, which sits beside Context here').toBeUndefined()
  expect(await band.find({ key: 'compact-yes' })).toBeDefined()
  await band.unmount()
})

test('every step is listed: a tighter layout where that avoids scrolling, else the band scrolls', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() }, { kind: 'seven_day', percentUsed: 52 }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a1', items: names.map((content, i) => ({ content, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending' })) } as never)
  const look = async (maxRows: number) => {
    const sized = { ...(props as object), maxRows } as never
    const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: sized })
    const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
    const isFramed = (await band.findAll({ type: 'Box' })).some(box => (box.props as { borderStyle?: string }).borderStyle)
    const cardGap = ((await band.find({ key: 'card' }))?.props as { rowGap?: unknown } | undefined)?.rowGap
    await band.unmount()
    return { all, isFramed, cardGap }
  }
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  await band.press({ key: 'more' })
  await band.unmount()

  // Fourteen rows hold all six steps once the card drops its frame.
  const roomy = await look(14)
  for (const name of names) expect(roomy.all, `${name} is listed`).toContain(name)
  expect(roomy.isFramed, 'the frame gives way, so nothing scrolls').toBe(false)
  expect(roomy.cardGap, 'the same small step below the steps as above them').toBe('sm')
  expect(roomy.all, 'nothing is summed up').not.toContain('more below')

  // Ten rows cannot hold them in any layout: all six are listed anyway, in the full card, and the band scrolls.
  const tight = await look(10)
  for (const name of names) expect(tight.all, `${name} is listed`).toContain(name)
  expect(tight.isFramed, 'the full card, since it scrolls anyway').toBe(true)
  expect(tight.all, 'the grid follows the steps').toContain('7d limit')
})

/** The details' text, opened. */
async function detailsOf($: { ui: { mount: (input: never) => Promise<unknown> } }) {
  type Band = {
    press: (q: object) => Promise<void>
    unmount: () => Promise<void>
    find: (q: object) => Promise<{ props: unknown } | undefined>
    findAll: (q: object) => Promise<{ text: string }[]>
  }
  const tall = { ...(props as object), maxRows: 40 }
  const mount = () => $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: tall } as never) as Promise<Band>
  let band = await mount()
  const toggle = (await band.find({ key: 'more' }))?.props as { label?: string } | undefined
  if (toggle?.label === '▾') {
    await band.press({ key: 'more' })
    await band.unmount()
    band = await mount()
  }
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  await band.unmount()
  return all
}

test('each request is weighted by the prices of the model that answered', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [] })
  // The same tokens three times: 1k new, 100k read, 2k written, 1k out.
  const models = ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']
  on('turn.step', async function* ($, e) {
    const asked = e as { turnId: string; index: number }
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000, model: models[asked.index] }
    return { turnId: asked.turnId, index: asked.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  } as never)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  for (const index of [0, 1, 2]) await request($ as never, 't1', index)
  await clock.advance(10_000)
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  await band.unmount()
  // Opus 5.5:   1 × (1k + 0.05 × 100k + 2 × 2k + 5 × 1k)               = 15k
  // Haiku 5.5:  0.5/4 × (1k + 0.1 × 100k + 2 × 2k + 5 × 1k), over 100k  = 2.5k
  // Sonnet 5.5: 2/4 × (1k + 0.05 × 100k + 2 × 2k + 5 × 1k)              = 7.5k
  expect(all, 'not 312k raw tokens: 25k creds').toContain('10s · 25k creds')
})

test('with a cost ledger, creds follow Claude Code\'s own cost, fast mode included', { timeoutMs: 30_000 }, async ($, on) => {
  const resets = new Date(START + 200 * MIN).toISOString()
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: resets }], cost: 2 })
  // The band's table would price each request at 50k ($0.20); fast mode doubles it, which only the ledger knows.
  step(on as never, { input_tokens: 0, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  for (let index = 0; index < 3; index += 1) {
    await request($ as never, 't1', index)
    await $.session.measure({ cost: { usd: 2 + 0.4 * (index + 1) }, changed: ['cost'] } as never)
  }
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 13, resetsAt: resets }], changed: ['rateLimits'] } as never)
  await clock.advance(10_000)
  const all = await detailsOf($ as never)
  expect(all, '$1.20 at $4 per million, not the table\'s 150k').toContain('300k creds')
  expect(all).toContain('$1.20')
  expect(all, 'and how far the limit moved').toContain('5h +3.0%')
})

test('a turn that runs its 5-hour window to the end and on into the next counts both', { timeoutMs: 30_000 }, async ($, on) => {
  const first = new Date(START + 60 * MIN).toISOString()
  const second = new Date(START + 60 * MIN + 300 * MIN).toISOString()
  const reading = (percentUsed: number, resetsAt: string) => ({ rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] }) as never
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: first }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  // From 40% to the end of the window, then 30% of the next one.
  await $.session.measure(reading(100, first))
  await clock.advance(65 * MIN)
  await $.session.measure(reading(30, second))
  expect(await detailsOf($ as never), '60 points of the old window and 30 of the new').toContain('5h +90.0%')
})

test('a turn that begins after its window ran out counts from zero in the new one', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(START + 10 * MIN).toISOString() }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await clock.advance(15 * MIN)
  // The engine still holds the ended window's 90% when the turn begins.
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(START + 315 * MIN).toISOString() }], changed: ['rateLimits'] } as never)
  const all = await detailsOf($ as never)
  expect(all, 'not a fall of 87 points, nor 90 carried over').toContain('5h +3.0%')
})

test('on a narrow window the band drops its extras but keeps every figure whole', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a1', items: [{ content: 'Put the full text in the new chat so nothing is lost on the way', status: 'in_progress' }, { content: 'Test it', status: 'pending' }, { content: 'Ship it', status: 'pending' }] } as never)
  await clock.advance(61_000)
  const narrow = { ...(props as object), bodyColumns: 70 } as never
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: narrow })
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  expect(all, 'the step count is whole').toContain('0/3')
  expect(all).toContain('25%')
  expect(all, 'the reset time is dropped').not.toContain('↻')
  expect(all, 'the elapsed time is dropped').not.toContain('1m 01s')
  // The row is the band's width and no more: the task gives way, the right side keeps whole.
  const row = (await band.find({ key: 'row' }))?.props as { width?: string; minWidth?: number }
  expect(row.width, 'the row spans the band, so the right side reaches its edge').toBe('100%')
  expect(row.minWidth, 'a long title cannot push the row past the band').toBe(0)
  const task = (await band.find({ key: 'task' }))?.props as { flexGrow?: number; flexShrink?: number; overflow?: string }
  expect([task.flexGrow, task.flexShrink, task.overflow], 'the task takes the spare room and gives way first').toEqual([1, 1, 'hidden'])
  const right = (await band.find({ key: 'right' }))?.props as { flexShrink?: number }
  expect(right.flexShrink, 'the limit, the cache and the toggle never shrink').toBe(0)
  expect(await band.find({ key: 'more' }), 'the toggle is drawn').toBeDefined()
})

test('with the details closed the row still spans the band, so the right side reaches its edge', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 45, resetsAt: new Date(START + 176 * MIN).toISOString() }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  const outer = (await band.findAll({ type: 'Box' }))[0]?.props as { flexDirection?: string }
  expect(outer.flexDirection, 'a column, so the row is stretched to the full width').toBe('column')
  await band.unmount()
})

test('the cache lifetime setting shortens the countdown', { options: { cacheMinutes: '5' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'hello', turnId: 't1' } as never)
  await clock.advance(60_000)
  const band = await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props })
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  expect(all).toContain('4:00')
  expect(all, 'no subscription reading').toContain('no reading yet')
})

test('the notice is off by default, and the sound can be turned off', { options: { finishSound: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'hello', turnId: 't1' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 120_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(57 * MIN)
  await clock.settle()
  expect(world.runs, 'no chime').toHaveLength(0)
  expect(world.notes, 'no notice').toHaveLength(0)
})

// ---- The cold-send cost and keepwarm ----

/** Runs /keepwarm with these words and gives back its answer. */
async function keepwarm($: { command: { run: (input: never) => Promise<unknown> } }, args: string) {
  const ran = (await $.command.run({ command: 'keepwarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)) as { text?: string }
  return ran.text ?? ''
}

/** The closed band's text, as wide or as narrow as asked. */
async function rowOf($: { ui: { mount: (input: never) => Promise<unknown> } }, bodyColumns = 120) {
  type Band = { unmount: () => Promise<void>; findAll: (q: object) => Promise<{ text: string }[]> }
  const band = (await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: { ...(props as object), bodyColumns } } as never)) as Band
  const all = (await band.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
  await band.unmount()
  return all
}

/** One prompt, answered at once. */
async function oneTurn($: { turn: { start: (input: never) => Promise<unknown>; complete: (input: never) => Promise<unknown> } }, turnId: string) {
  await $.turn.start({ text: 'hello', turnId } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId, reason: 'answer' } as never)
}

test('once the cache is cold the band says what the next send costs, in creds', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [], context: { tokens: 215_000, window: 1_000_000 } })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(30 * MIN)
  expect(await rowOf($ as never), 'warm: no price yet').not.toContain('next send')
  await clock.advance(31 * MIN)
  // 215k of context written again on the 1-hour cache: 2 × 215k at Opus 5.5's price.
  const wide = await rowOf($ as never)
  expect(wide).toContain('cold')
  expect(wide).toContain('next send ≈430k creds')
  expect(await rowOf($ as never, 70), 'narrow: the figure alone').toContain('≈430k')
})

test('a cold send on the 5-minute cache is priced at its own write rate', { options: { cacheMinutes: '5' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [], context: { tokens: 215_000, window: 1_000_000 } })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(6 * MIN)
  expect(await rowOf($ as never), '1.25 × 215k').toContain('next send ≈269k creds')
  expect(await keepwarm($ as never, ''), 'no pings every few minutes').toContain('needs the one-hour cache')
})

/** Where the band keeps, by model, the head of the prompt a cold send found cached. */
const HEADS = 'prefix-by-model'
const headOf = (world: World, model = 'claude-opus-5-5') => (world.store![HEADS] as Record<string, number> | undefined)?.[model]

// Auto keepwarm off, so no ping holds the cache warm after the cold send.
test('a cold send measures the head of the prompt that stayed cached, and the next one prices it as a read', { options: { autoWarm: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  // The cold send reads 60k of its 215k prompt from the cache all the same: the tools and system prompt.
  step(on as never, { input_tokens: 2, output_tokens: 500, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 155_000 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(61 * MIN)
  expect(await rowOf($ as never), 'nothing measured yet: all of it written').toContain('next send ≈430k creds')
  await $.turn.start({ text: 'hello', turnId: 't2' } as never)
  await request($ as never, 't2', 0)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(headOf(world), 'kept for every chat, under its model').toBe(60_000)
  // 155k written at 2× and 60k read at 0.05×: 310k + 3k.
  const band = await mountBand($ as never)
  const tip = (await band.findAll({ type: 'Svg' })).map(one => String(one.props.alt)).find(alt => alt.startsWith('goes cold'))
  await band.unmount()
  expect(tip).toMatch(/· a send after that ≈313k creds$/)
  await clock.advance(61 * MIN)
  expect(await rowOf($ as never)).toContain('next send ≈313k creds')
})

test('after a compaction the next send is priced by what it writes, with the head still cached, and measures it again', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, store: { [HEADS]: { 'claude-opus-5-5': 60_000 } } }
  const clock = engine(on as never, world)
  step(on as never, { input_tokens: 2, output_tokens: 800, cache_read_input_tokens: 57_000, cache_creation_input_tokens: 25_000 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  world.context = { window: 1_000_000 }
  world.counted = 80_000
  await clock.advance(5_000)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row).toContain('cold')
  // 20k of summary written at 2×, 60k read at 0.05×: 40k + 3k, not 2 × 80k.
  expect(row).toContain('next send ≈43k creds')
  world.context = { tokens: 82_000, window: 1_000_000 }
  await $.turn.start({ text: 'hi', turnId: 't2' } as never)
  await request($ as never, 't2', 0)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(headOf(world), 'what that send read back').toBe(57_000)
})

test('a send the band took for cold that read nearly all its prompt measures nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, store: { [HEADS]: { 'claude-opus-5-5': 60_000 }, prefix: 61_000 } }
  const clock = engine(on as never, world)
  step(on as never, { input_tokens: 2, output_tokens: 500, cache_read_input_tokens: 210_000, cache_creation_input_tokens: 5_000 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(61 * MIN)
  await $.turn.start({ text: 'hello', turnId: 't2' } as never)
  await request($ as never, 't2', 0)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(headOf(world)).toBe(60_000)
  expect(world.store!.prefix, "1.17.0's one figure for every model is never read nor written").toBe(61_000)
})

// ---- A model switch ----

/** A switch as the engine raises it; /model answers the new model from then on. */
function switchTo(world: World, from: string, to: string, source = 'picker') {
  if (source !== 'resume') world.model = to
  return { from_model: from, to_model: to, requested_model: null, source, context_tokens: 215_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'catalog' } as never
}

test('a model switch prices the next send on the new model and holds the pings; switching back undoes it', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, store: { [HEADS]: { 'claude-opus-5-5': 60_000 } } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await keepwarm($ as never, '6h')
  await clock.advance(10 * MIN)
  await $.classic.PostModelSwitch(switchTo(world, 'claude-fable-5-2', 'claude-opus-5-5', 'resume'))
  expect(await rowOf($ as never), 'a resume brings its own chat and is no switch').toContain('50m')
  await $.classic.PostModelSwitch(switchTo(world, 'claude-opus-5-5', 'claude-sonnet-5-5[1m]'))
  const row = await rowOf($ as never)
  expect(row, 'none of the chat is cached on Sonnet').toContain('cold')
  // Sonnet 5.5 costs half what Opus 5.5 does, and has no head measured: 0.5 × 2 × 215k.
  expect(row).toContain('next send ≈215k creds')
  const band = await mountBand($ as never)
  const tip = (await band.findAll({ type: 'Svg' })).map(one => String(one.props.alt)).find(alt => alt.startsWith('nothing of this chat'))
  await band.unmount()
  expect(tip).toMatch(/^nothing of this chat cached on Sonnet 5\.5 · on Opus 5\.5 it stays warm until /)
  expect(world.status!.at(-1)).toContain('nothing cached on Sonnet 5.5 yet, first ping after the next turn')
  await clock.advance(45 * MIN)
  await clock.settle()
  expect(world.forked, 'no ping writes the chat to Sonnet').toBe(0)
  // Back on Opus before any send: its cache is where it was, and the held ping goes out.
  await $.classic.PostModelSwitch(switchTo(world, 'claude-sonnet-5-5[1m]', 'claude-opus-5-5'))
  expect(await rowOf($ as never)).not.toContain('next send')
  await clock.advance(2000)
  await clock.settle()
  expect(world.forked).toBe(1)
})

test('the first send on a model switched to measures its own head, and each model keeps its own', { options: { autoWarm: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, store: { [HEADS]: { 'claude-opus-5-5': 60_000 } } }
  const clock = engine(on as never, world)
  // A model seldom used: nothing of the prompt was cached on it, the head included.
  step(on as never, { input_tokens: 2, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 215_000 }, 'claude-sonnet-5-5')
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await $.classic.PostModelSwitch(switchTo(world, 'claude-opus-5-5', 'claude-sonnet-5-5'))
  await $.turn.start({ text: 'hello', turnId: 't2' } as never)
  await request($ as never, 't2', 0)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(headOf(world, 'claude-sonnet-5-5')).toBe(0)
  expect(headOf(world), 'Opus keeps its own').toBe(60_000)
  expect(await rowOf($ as never), 'the cache is on Sonnet now, and warm').not.toContain('next send')
  // Back to Opus: 155k written at 2× and Opus's 60k head read at 0.05×.
  await $.classic.PostModelSwitch(switchTo(world, 'claude-sonnet-5-5', 'claude-opus-5-5'))
  expect(await rowOf($ as never)).toContain('next send ≈313k creds')
  await clock.settle()
})

test('where the switch event is kept from the band, it sees /model change within seconds', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(10 * MIN)
  // No event: only what /model now answers.
  world.model = 'Sonnet 5.5 (1M context)'
  await clock.advance(5_000)
  await clock.settle()
  expect(await rowOf($ as never)).toContain('next send ≈215k creds')
  // An alias the band cannot read as a model changes nothing.
  world.model = 'opus'
  await clock.advance(5_000)
  await clock.settle()
  expect(await rowOf($ as never)).toContain('next send ≈215k creds')
  world.model = 'claude-opus-5-5[1m]'
  await clock.advance(5_000)
  await clock.settle()
  expect(await rowOf($ as never), 'back on Opus: warm').not.toContain('next send')
})

test('/keepwarm pings after 50 idle minutes, keeps the cache warm, and stops on off', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  const armed = await keepwarm($ as never, '')
  expect(armed).toContain('keepwarm on for 6h')
  expect(armed, 'a read of 200k at 0.05').toContain('A ping costs about 10k creds')
  expect(armed, 'against a write of 200k at 2').toContain('a cold send would cost about 400k')
  expect(await rowOf($ as never), 'the window is on the status line, not the band').not.toContain('⟳')
  expect(world.status!.at(-1)).toContain('⟳ 6h')
  await clock.advance(49 * MIN)
  await clock.settle()
  expect(world.forked, 'not before 50 idle minutes').toBe(0)
  await clock.advance(MIN + 1000)
  await clock.settle()
  expect(world.forked, 'one ping').toBe(1)
  const row = await rowOf($ as never)
  expect(row, 'the ping refreshed the cache').toContain('60m')
  expect(row, 'not on the band').not.toContain('⟳')
  expect(world.status!.at(-1)).toContain('⟳ 5h 10m')
  const status = await keepwarm($ as never, 'status')
  expect(status).toContain('next ping in 50m')
  expect(status).toContain('last ping read 200k tokens')
  await clock.advance(50 * MIN)
  await clock.settle()
  expect(world.forked, 'and the next').toBe(2)
  expect(await keepwarm($ as never, 'off')).toBe('keepwarm is off')
  await clock.advance(90 * MIN)
  await clock.advance(90 * MIN)
  await clock.settle()
  expect(world.forked, 'none after off').toBe(2)
  expect(world.status!.at(-1), 'the status line is gone').toBeUndefined()
})

test('a window of your own, a testing period, and words keepwarm does not take', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  expect(await keepwarm($ as never, '90m')).toContain('keepwarm on for 1h 30m')
  expect(await keepwarm($ as never, 'soon'), 'not a window').toContain('keepwarm takes a window')
  expect(await keepwarm($ as never, '1h every 90m'), 'past the cache').toContain('every takes a period from 1m to 59m')
  expect(await keepwarm($ as never, '1h every 2m')).toContain('after 2m idle')
  await clock.advance(2 * MIN + 1000)
  await clock.settle()
  expect(world.forked, 'every two minutes').toBe(1)
  await clock.advance(2 * MIN)
  await clock.settle()
  expect(world.forked).toBe(2)
  await clock.advance(60 * MIN)
  await clock.settle()
  expect(await keepwarm($ as never, 'status'), 'the window ended').toBe('keepwarm is off')
})

test('a ping that finds the cache gone stops keepwarm and says why', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 }, forks: [{ read: 0, write: 200_000 }] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await keepwarm($ as never, '6h')
  await clock.advance(50 * MIN + 1000)
  await clock.settle()
  expect(world.forked).toBe(1)
  expect(world.logs!.join('\n')).toContain('keepwarm stopped, the ping read 0 and wrote 200k tokens')
  expect(world.status!.at(-1)).toContain('⟳ stopped: the ping read 0')
  expect(await keepwarm($ as never, 'status')).toContain('keepwarm stopped')
  await clock.advance(90 * MIN)
  await clock.advance(90 * MIN)
  await clock.settle()
  expect(world.forked, 'no more pings').toBe(1)
})

test('a busy API is tried again, and nothing to fork waits for the next turn', { timeoutMs: 30_000 }, async ($, on) => {
  const busy = { isAnswered: false as const, reason: 'api-error', status: 529, error: 'overloaded' }
  const nothing = { isAnswered: false as const, reason: 'nothing-to-fork' }
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 }, forks: [busy, { read: 200_000, write: 0 }, nothing] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await keepwarm($ as never, '6h')
  await clock.advance(50 * MIN + 1000)
  await clock.settle()
  expect(world.forked).toBe(1)
  expect(await keepwarm($ as never, 'status')).toContain('ping retry 1 of 3')
  await clock.advance(MIN)
  await clock.settle()
  expect(world.forked, 'the retry landed').toBe(2)
  expect(await keepwarm($ as never, 'status')).toContain('last ping read 200k')
  // The next ping finds nothing to fork: the window waits for a turn instead of ending.
  await clock.advance(50 * MIN)
  await clock.settle()
  expect(world.forked).toBe(3)
  expect(world.logs!.join('\n')).toContain('nothing to fork')
  await clock.advance(2 * 60 * MIN)
  await clock.settle()
  expect(world.forked, 'no ping while it waits').toBe(3)
  await oneTurn($ as never, 't2')
  await clock.advance(50 * MIN + 1000)
  await clock.settle()
  expect(world.forked, 'pings again after the turn').toBe(4)
})

test('always renews the window after every turn until off', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  expect(await keepwarm($ as never, 'always 200h'), 'up to a week').toContain('always takes one window from 1h to 168h')
  expect(await keepwarm($ as never, 'always 24h')).toContain('until 24h after its last turn')
  expect(await keepwarm($ as never, 'status')).toContain('keepwarm 1d 00h left (always, 24h after each turn)')
  await clock.advance(90 * MIN)
  await clock.advance(90 * MIN)
  await oneTurn($ as never, 't2')
  expect(await keepwarm($ as never, 'status'), 'renewed by the turn').toContain('keepwarm 1d 00h left')
  expect(await keepwarm($ as never, 'off')).toContain('always is off for every session')
  await oneTurn($ as never, 't3')
  expect(await keepwarm($ as never, 'status'), 'a turn no longer arms it').toBe('keepwarm is off')
})

test('a send into a cold cache arms three hours of keepwarm by itself', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(30 * MIN)
  await oneTurn($ as never, 't2')
  expect(await keepwarm($ as never, 'status'), 'a warm send arms nothing').toBe('keepwarm is off')
  await clock.advance(61 * MIN)
  await oneTurn($ as never, 't3')
  expect(world.logs!.join('\n')).toContain('Keepwarm holds it warm for 3h')
  expect(await keepwarm($ as never, 'status')).toContain('keepwarm 3h 00m left')
})

test('with Auto keepwarm off a cold send arms nothing', { options: { autoWarm: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(61 * MIN)
  await oneTurn($ as never, 't2')
  expect(await keepwarm($ as never, 'status')).toBe('keepwarm is off')
  expect(world.logs, 'nothing said').toHaveLength(0)
})

test('the cost a ping adds between turns is not put on the turn before it', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [], cost: 2 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure({ cost: { usd: 2.4 }, changed: ['cost'] } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(50 * MIN)
  await $.session.measure({ cost: { usd: 2.45 }, changed: ['cost'] } as never)
  const all = await detailsOf($ as never)
  expect(all, 'the ping after the turn is left out').toContain('$0.40')
  expect(all).toContain('100k')
})

test('keepwarm keeps a status line by the model picker: time left, the next ping, the last readback', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 }, forks: [{ read: 200_000, write: 0 }, { read: 0, write: 200_000 }] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.settle()
  expect(world.status!.at(-1), 'nothing while keepwarm is off').toBeUndefined()
  await keepwarm($ as never, '')
  expect(world.status!.at(-1)).toBe('keeping warm ⟳ 6h · ping in 50m')
  await clock.advance(10 * MIN)
  expect(world.status!.at(-1), 'counts down in minutes').toBe('keeping warm ⟳ 5h 50m · ping in 40m')
  const sent = world.status!.length
  await clock.advance(20_000)
  expect(world.status!.length, 'sent only when its words change').toBe(sent)
  await clock.advance(40 * MIN)
  await clock.settle()
  // A read of 200k at Opus 5.5's 0.05: 10k creds.
  expect(world.status!.at(-1)).toBe('keeping warm ⟳ 5h 10m · ping in 50m · last ping read 10k creds')
  await clock.advance(50 * MIN + 1000)
  await clock.settle()
  expect(world.status!.at(-1), 'a ping that found the cache gone').toBe('⟳ stopped: the ping read 0 and wrote 200k tokens, so the cache had already gone cold')
  await keepwarm($ as never, 'off')
  expect(world.status!.at(-1), 'off takes it away').toBeUndefined()
})

// ---- A chat opened again ----

const kept = (minutesAgo: number) => ({ at: START - minutesAgo * MIN, tokens: 215_000, window: 1_000_000, model: 'claude-opus-5-5' })

test('every turn keeps when the cache was refreshed and over how much, under the chat\'s id', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(5 * MIN)
  await oneTurn($ as never, 't1')
  expect(world.store!['cache:S1']).toEqual({ at: START + 5 * MIN, tokens: 215_000, window: 1_000_000, model: 'claude-opus-5-5' })
})

test('a chat opened again after the cache went cold says so, and what the next send costs, before anything is sent', { timeoutMs: 30_000 }, async ($, on) => {
  // The engine has no context figure before the first response of the reopened chat.
  const world: World = { limits: [], context: { window: 1_000_000 }, turns: 12, store: { 'cache:S1': kept(120) } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row).toContain('cold')
  expect(row).toContain('next send ≈430k creds')
})

test('a chat opened again while its cache is warm counts down from its last refresh', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { window: 1_000_000 }, turns: 12, store: { 'cache:S1': kept(20) } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  expect(await rowOf($ as never)).toContain('40m')
})

test('a chat with history the band never saw says the cache is unknown and what a cold send costs', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, turns: 12 }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row).toContain('unknown')
  expect(row).toContain('if cold ≈430k creds')
})

test('a new chat has nothing cached, so nothing to price', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { window: 1_000_000 }, store: { 'cache:OLD': { ...kept(0), at: START - 40 * 24 * 60 * MIN } } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  expect(await rowOf($ as never)).toContain('not started')
  expect(world.store!['cache:OLD'], 'a chat untouched for 30 days is forgotten').toBeUndefined()
})

// ---- The row's chevron, hover and colors; step times; Keep warm in the details ----

type Mounted = {
  press: (q: object) => Promise<void>
  unmount: () => Promise<void>
  find: (q: object) => Promise<{ props: Record<string, unknown>; text?: string } | undefined>
  findAll: (q: object) => Promise<{ props: Record<string, unknown>; text: string }[]>
}
const mountBand = ($: { ui: { mount: (input: never) => Promise<unknown> } }, extra: object = {}) =>
  $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: { ...(props as object), maxRows: 40, ...extra } } as never) as Promise<Mounted>

test('the chevron is a glyph, the cache carries the desktop\'s own tooltip, and the 5h part none', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(START + 130 * MIN).toISOString() }], context: { tokens: 215_000, window: 1_000_000 } })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.advance(10 * MIN)
  // The clock's picture: drawn live, so its <title> is the app's own tooltip.
  const clockOf = async (band: Mounted) =>
    (await band.findAll({ type: 'Svg' })).map(one => one.props as { alt?: string; source?: string; isInteractive?: boolean }).find(one => /^(goes cold|cold since)/.test(String(one.alt)))
  let band = await mountBand($ as never)
  expect((await band.find({ key: 'more' }))?.props.label, 'a chevron, not words').toBe('▾')
  let tip = await clockOf(band)
  expect(tip?.alt).toMatch(/^goes cold .* · a send after that ≈430k creds$/)
  expect(tip?.source, 'the tooltip').toMatch(/<title>goes cold .* · a send after that ≈430k creds<\/title>/)
  expect(tip?.isInteractive, 'drawn live, so the tooltip works').toBe(true)
  expect(((await band.find({ key: 'cache' })) as { text?: string } | undefined)?.text, 'the clock stands in the cache part').toContain('cache')
  expect(await hiddenOf(band), 'no hidden words left on the row').toEqual([])
  const pictures = (await band.findAll({ type: 'Svg' })).map(one => `${String(one.props.alt)} ${String(one.props.source)}`).join(' | ')
  expect(pictures, 'nothing on the 5h part says when it resets').not.toContain('resets')
  await band.press({ key: 'more' })
  await band.unmount()
  band = await mountBand($ as never)
  expect((await band.find({ key: 'more' }))?.props.label, 'open: the other way').toBe('▴')
  await band.press({ key: 'more' })
  await band.unmount()
  // Cold, it says since when.
  await clock.advance(51 * MIN)
  band = await mountBand($ as never)
  tip = await clockOf(band)
  expect(tip?.alt).toMatch(/^cold since /)
  await band.unmount()
  // The terminal has no pointer to hover with.
  const terminal = (await $.ui.mount({ plugin: 'taskband', surface: 'terminal', component: 'AbovePrompt', props } as never)) as Mounted
  expect(await terminal.findAll({ type: 'Svg' })).toEqual([])
  await terminal.unmount()
})

// ---- After a compaction or /clear ----

test('a /compact between turns shows the new size within seconds, reads cold, and keepwarm waits', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await keepwarm($ as never, '6h')
  await clock.advance(10 * MIN)
  expect(await rowOf($ as never)).toContain('50m')
  // /compact typed, its event kept from the band: only the fill goes, until the next reply.
  world.context = { window: 1_000_000 }
  world.counted = 31_000
  await clock.advance(5_000)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row, 'the summary is not cached yet').toContain('cold')
  expect(row, 'priced by the new size').toContain('next send ≈62k creds')
  expect(await detailsOf($ as never), 'the size /context counts').toContain('31k of')
  expect(world.status!.at(-1), 'keepwarm waits for the next send').toContain('cache cold, first ping after the next turn')
  expect((world.store!['cache:S1'] as { tokens: number }).tokens, 'kept for a restart').toBe(31_000)
  await clock.advance(50 * MIN)
  await clock.settle()
  expect(world.forked, 'no ping over a cache that holds the old chat').toBe(0)
  // The next reply's own figure takes over, and keepwarm goes on over the new chat.
  world.context = { tokens: 33_000, window: 1_000_000 }
  await oneTurn($ as never, 't2')
  await $.session.measure({ context: world.context, rateLimits: [], changed: ['context'] } as never)
  expect(await rowOf($ as never)).toContain('60m')
  expect(await detailsOf($ as never)).toContain('33k of')
  expect(world.status!.at(-1)).toContain('ping in 50m')
  await clock.advance(50 * MIN + 1000)
  await clock.settle()
  expect(world.forked, 'pings again').toBe(1)
})

test('the send after a compaction arms no auto keepwarm: it writes only the summary', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  world.context = { window: 1_000_000 }
  world.counted = 31_000
  await clock.advance(5_000)
  await clock.settle()
  world.context = { tokens: 33_000, window: 1_000_000 }
  await oneTurn($ as never, 't2')
  expect(await keepwarm($ as never, 'status')).toBe('keepwarm is off')
})

test('the band\'s Compact counts the new size the same way', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 150_000, window: 200_000 }, counted: 24_000 }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await oneTurn($ as never, 't1')
  let band = await mountBand($ as never)
  await band.press({ key: 'more' })
  await band.unmount()
  band = await mountBand($ as never)
  await band.press({ key: 'compact' })
  await band.unmount()
  band = await mountBand($ as never)
  await band.press({ key: 'compact-yes' })
  await band.unmount()
  await clock.settle()
  expect(world.compacted).toBe(1)
  expect(await detailsOf($ as never)).toContain('24k of 200k')
  expect(await rowOf($ as never)).toContain('next send ≈48k creds')
})

test('/clear empties the fill into a new chat: its size, and nothing cached yet', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 } }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await $.session.end({ reason: 'clear', sessionId: 'S1' } as never)
  world.context = { window: 1_000_000 }
  world.counted = 18_000
  await clock.advance(5_000)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row).toContain('not started')
  expect(row).not.toContain('next send')
  expect(await detailsOf($ as never)).toContain('18k of')
})

test('a chat reopened before its first reply is no compaction', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { window: 1_000_000 }, turns: 12, store: { 'cache:S1': kept(20) }, counted: 9_000 }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(15_000)
  await clock.settle()
  const row = await rowOf($ as never)
  expect(row, 'still warm from its last refresh').toContain('40m')
  expect(await detailsOf($ as never), 'the size it was left at').toContain('215k of')
})

for (const [context, color] of [[30_000, undefined], [80_000, 'warning'], [215_000, 'error']] as const) {
  test(`a cold send of ${2 * context / 1000}k creds is drawn ${color ?? 'grey'}`, { timeoutMs: 30_000 }, async ($, on) => {
    const clock = engine(on as never, { limits: [], context: { tokens: context, window: 1_000_000 } })
    await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
    await oneTurn($ as never, 't1')
    await clock.advance(61 * MIN)
    const band = await mountBand($ as never)
    const figure = await band.find({ type: 'Text', text: /^next send/ })
    await band.unmount()
    expect(figure?.props.color).toBe(color)
  })
}

test('each step shows how long it took; one never seen running shows none', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a1', items: [{ content: 'Read the code', status: 'in_progress' }, { content: 'Write the fix', status: 'pending' }, { content: 'Ship it', status: 'pending' }] } as never)
  await clock.advance(70_000)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a2', advance: true } as never)
  await clock.advance(30_000)
  let all = await detailsOf($ as never)
  expect(all, 'the first, done').toContain('Read the code | 1m 10s')
  expect(all, 'the second, running').toContain('Write the fix | 30s')
  // The whole list again, as a list tool resends it: the times carry over by the wording.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a3', items: [{ content: 'Read the code', status: 'completed' }, { content: 'Write the fix', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }] } as never)
  await clock.advance(15_000)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', tool_use_id: 'a4', recap: 'Done.' } as never)
  all = await detailsOf($ as never)
  expect(all).toContain('Read the code | 1m 10s')
  expect(all, 'checked off at the wrap-up').toContain('Write the fix | 45s')
  expect(all, 'never seen running: no time').not.toMatch(/Ship it \| (\d+s|\d+m \d+s|\d+h \d+m)\b/)
})

test('Keep warm on the 7d line gives 3h, 6h and Off where Compact stands, and nothing else moves', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = {
    limits: [
      { kind: 'five_hour', percentUsed: 25, resetsAt: new Date(START + 176 * MIN).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(START + 3 * 24 * 60 * MIN).toISOString() },
    ],
    context: { tokens: 150_000, window: 200_000 },
  }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await oneTurn($ as never, 't1')
  const widths = async (band: Mounted) => (await band.findAll({ type: 'Svg' })).map(one => one.props.width)
  let band = await mountBand($ as never)
  await band.press({ key: 'more' })
  await band.unmount()
  band = await mountBand($ as never)
  const resting = await widths(band)
  expect(await band.find({ key: 'keepwarm' }), 'on the 7d line').toBeDefined()
  expect(await band.find({ key: 'compact' }), 'Compact where it was').toBeDefined()
  await band.press({ key: 'keepwarm' })
  await band.unmount()
  band = await mountBand($ as never)
  expect(await band.find({ key: 'week-wq' }), 'its question in its place').toBeDefined()
  // The question and the three buttons each fill the room right of their pill and centre in it,
  // so the question stands centred over the buttons.
  const slot = async (key: string) => {
    const one = (await band.find({ key }))?.props as { flexGrow?: number; justifyContent?: string } | undefined
    return [one?.flexGrow, one?.justifyContent]
  }
  expect(await slot('week-wq'), 'the question, centred').toEqual([1, 'center'])
  expect(await slot('wq'), 'the buttons, centred alike').toEqual([1, 'center'])
  expect(await band.find({ key: 'cs' }), 'no spacer pushing the buttons right').toBeUndefined()
  expect(await band.find({ key: 'keepwarm' })).toBeUndefined()
  expect(await band.find({ key: 'compact' }), 'Compact gives way').toBeUndefined()
  for (const key of ['keepwarm-3h', 'keepwarm-6h', 'keepwarm-off']) expect(await band.find({ key }), key).toBeDefined()
  expect(await widths(band), 'every pill keeps its width').toEqual(resting)
  await band.press({ key: 'keepwarm-3h' })
  await band.unmount()
  await clock.settle()
  expect(world.toasts).toContain('Keeping the cache warm for 3h.')
  expect(await keepwarm($ as never, 'status')).toContain('keepwarm 3h 00m left')
  band = await mountBand($ as never)
  expect(await band.find({ key: 'compact' }), 'back at rest').toBeDefined()
  expect(await band.find({ key: 'keepwarm' })).toBeDefined()
  // Compact asking takes the 7d line's spot for its own question; Keep warm comes back after.
  await band.press({ key: 'compact' })
  await band.unmount()
  band = await mountBand($ as never)
  expect(await band.find({ key: 'week-q' })).toBeDefined()
  expect(await band.find({ key: 'keepwarm' })).toBeUndefined()
  await band.press({ key: 'compact-no' })
  await band.unmount()
  band = await mountBand($ as never)
  await band.press({ key: 'keepwarm' })
  await band.unmount()
  band = await mountBand($ as never)
  await band.press({ key: 'keepwarm-off' })
  await band.unmount()
  await clock.settle()
  expect(await keepwarm($ as never, 'status')).toBe('keepwarm is off')
})

// ---- Forecasts come from the table alone; nothing is learned across chats (1.20.0) ----

test('forecasts are the table\'s alone, whatever an old tally holds', { timeoutMs: 30_000 }, async ($, on) => {
  const world: World = { limits: [], context: { tokens: 215_000, window: 1_000_000 }, cost: 2, store: { 'scale-by-model': { 'claude-opus-5-5': { ledger: 100_000, table: 50_000 } } } }
  const clock = engine(on as never, world)
  // The table prices this request at 50k creds ($0.20); Claude Code's ledger says $0.40, twice that.
  step(on as never, { input_tokens: 0, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await request($ as never, 't1', 0)
  await $.session.measure({ cost: { usd: 2.4 }, changed: ['cost'] } as never)
  world.cost = 2.4
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()

  // 215k written again on the 1-hour cache: 430k by the table, whatever the ledger said of past prompts.
  expect(await keepwarm($ as never, ''), 'the forecast /keepwarm gives').toContain('a cold send would cost about 430k')
  await keepwarm($ as never, 'off')
  await clock.advance(61 * MIN)
  expect(await rowOf($ as never), 'and the band').toContain('next send ≈430k creds')
  await $.turn.start({ text: 'again', turnId: 't2' } as never)
  expect(world.store!['scale-by-model'], 'nothing new is kept in it').toEqual({ 'claude-opus-5-5': { ledger: 100_000, table: 50_000 } })
})

test('what a ping cost is read off Claude Code\'s own ledger', { timeoutMs: 30_000 }, async ($, on) => {
  // The table prices the ping's read of 200k at 10k creds; Claude Code's ledger moves by $0.06, 15k creds.
  const world: World = { limits: [], context: { tokens: 200_000, window: 1_000_000 }, cost: 2, pingUsd: 0.06, forks: [{ read: 200_000, write: 0 }] }
  const clock = engine(on as never, world)
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.settle()
  await keepwarm($ as never, '')
  await clock.advance(50 * MIN)
  await clock.settle()
  expect(world.forked, 'one ping').toBe(1)
  expect(world.status!.at(-1)).toContain('last ping read 15k creds')
})

// ---- Motion (1.21.0) ----

type Picture = { alt: string; source: string; width?: number }
/** The pictures the band draws on the desktop, each mount a redraw. */
async function picturesOf($: { ui: { mount: (input: never) => Promise<unknown> } }) {
  type Band = { unmount: () => Promise<void>; findAll: (q: object) => Promise<{ props: unknown }[]> }
  const band = (await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props } as never)) as Band
  const all = (await band.findAll({ type: 'Svg' })).map(one => one.props as Picture)
  await band.unmount()
  return all
}
/** Where a repeating motion of `period` stands at `at`, as the band writes its begin. */
const phaseOf = (at: number, period: number) => `begin="${(-(((at % period) + period) % period) / 1000).toFixed(3)}s"`

test('a step done slides the progress bar to its new length, and a shimmer crosses it while Claude works', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a1', items: [{ content: 'Read the code', status: 'in_progress' }, { content: 'Write the fix', status: 'pending' }, { content: 'Run the tests', status: 'pending' }] } as never)
  await clock.settle()
  const task = async () => (await picturesOf($)).find(one => one.alt.endsWith('steps done'))?.source ?? ''
  const first = await task()
  expect(first, 'first sight: nothing to slide from').not.toContain('attributeName="width"')
  // Nothing filled yet: a wash of the bar's own colour crosses the empty track, in step with the clock.
  expect(first, 'a shimmer while Claude works').toContain(`${phaseOf(clock.now(), 2400)} repeatCount="indefinite"`)
  expect(first, 'in the bar\'s colour, over the track').toContain('stop-color="#d97757" stop-opacity="0.5"')

  // One of three done: 64 wide, the fill slides from empty to 21, eased out over 0.7s.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'a2', advance: true } as never)
  await clock.settle()
  const sliding = await task()
  expect(sliding).toContain('<animate attributeName="width" from="0" to="21"')
  expect(sliding).toContain('dur="0.700s" calcMode="spline" keyTimes="0;1" keySplines="0.33 1 0.68 1" fill="freeze"')
  // A redraw while it shows the same hands over the very same picture: the slide goes on, not over.
  await clock.advance(300)
  expect(await task(), 'the same picture mid-slide').toBe(sliding)
  // Once there, it is built again without the slide: the same length, the shimmer still in step.
  await clock.advance(500)
  const still = await task()
  expect(still).not.toContain('attributeName="width"')
  expect(still).toContain('width="21"')
  expect(still).toContain(`${phaseOf(clock.now(), 2400)} repeatCount="indefinite"`)
  expect(still, 'a light across the fill now').toContain('stop-color="#fff" stop-opacity="0.55"')

  // The turn ends with steps left: the bar holds still.
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  expect(await task(), 'no shimmer once Claude stops').not.toContain('attributeName="x"')
})

test('the cache clock\'s ring drains by itself over the cache\'s life, and a picture built again picks it up where it stands', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = engine(on as never, { limits: [] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await oneTurn($ as never, 't1')
  await clock.settle()
  const refreshed = clock.now()
  const ring = async (said = 'goes cold') => (await picturesOf($)).find(one => one.alt.startsWith(said))?.source ?? ''
  await clock.advance(10 * MIN)
  const seconds = (at: number) => ((at - refreshed) / 1000).toFixed(3)
  const draining = await ring()
  // Ten minutes in: the ring begins a tenth of an hour along its hour, and turns red at its last five minutes.
  expect(draining).toContain(`<animate attributeName="stroke-dashoffset" from="0" to="35.19" begin="-${seconds(clock.now())}s" dur="3600.000s" fill="freeze"/>`)
  expect(draining).toContain(`<set attributeName="stroke" to="#dc2626" begin="${(3300 - (clock.now() - refreshed) / 1000).toFixed(3)}s" fill="freeze"/>`)
  // Redraws hand over the same picture, still draining; within the minute it is built again from where it stands.
  await clock.advance(20_000)
  expect(await ring(), 'the same picture').toBe(draining)
  await clock.advance(50_000)
  const again = await ring()
  expect(again).not.toBe(draining)
  expect(again).toContain(`begin="-${seconds(clock.now())}s" dur="3600.000s"`)
  // Cold: the ring is empty and still.
  await clock.advance(55 * MIN)
  const cold = await ring('cold since')
  expect(cold, 'the clock is still drawn').toContain('<title>cold since')
  expect(cold).not.toContain('stroke-dashoffset')
})

test('a limit bar in the row slides when its percentage moves, and the details\' bars hold still', { timeoutMs: 30_000 }, async ($, on) => {
  const resets = new Date(START + 200 * MIN).toISOString()
  const clock = engine(on as never, { limits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: resets }, { kind: 'seven_day', percentUsed: 12 }] })
  await $.session.start({ source: 'startup', cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  const five = async () => (await picturesOf($)).find(one => one.alt.endsWith('5-hour limit used') && one.width === 48)?.source ?? ''
  expect(await five(), 'first sight: still').not.toContain('attributeName="width"')
  // 30% to 45% of 48: from 14 to 22.
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 45, resetsAt: resets }, { kind: 'seven_day', percentUsed: 12 }], changed: ['rateLimits'] } as never)
  await clock.settle()
  expect(await five()).toContain('<animate attributeName="width" from="14" to="22"')

  // The details' bars hold still: nothing sweeps in as they open, and nothing slides when a percentage moves.
  type Band = { press: (q: object) => Promise<void>; unmount: () => Promise<void>; findAll: (q: object) => Promise<{ props: unknown }[]> }
  const band = (await $.ui.mount({ plugin: 'taskband', surface: 'desktop', component: 'AbovePrompt', props: { ...(props as object), maxRows: 40 } } as never)) as Band
  const all = async () => (await band.findAll({ type: 'Svg' })).map(one => one.props as Picture)
  const inDetails = async () => (await all()).filter(one => one.width !== 48 && /(limit|context window) used$/.test(one.alt))
  await clock.advance(2_000)
  await band.press({ key: 'more' })
  const opened = await inDetails()
  expect(opened.map(one => one.alt).filter(alt => alt.endsWith('limit used')).sort(), 'both limits').toEqual(['12% of the 7d limit used', '45% of the 5h limit used'])
  for (const one of opened) expect(one.source, `${one.alt} holds still as the details open`).not.toContain('<animate')
  await $.session.measure({ rateLimits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: resets }, { kind: 'seven_day', percentUsed: 12 }], changed: ['rateLimits'] } as never)
  await clock.settle()
  const moved = await inDetails()
  expect(moved.map(one => one.alt), 'the new figure').toContain('60% of the 5h limit used')
  for (const one of moved) expect(one.source, `${one.alt} holds still as it moves`).not.toContain('<animate')
  // The row's bar slides all the same: 45% to 60% of 48, from 22 to 29.
  expect((await all()).find(one => one.width === 48 && one.alt.endsWith('5-hour limit used'))?.source).toContain('<animate attributeName="width" from="22" to="29"')
  await band.unmount()
})
