import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const START = 1_800_000_000_000
const FILE = '/home/me/.claude/water-reminder.json'
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const PANE = {
  plugin: 'water-reminder',
  component: 'Pane',
  requestId: 'water-reminder',
  props: {
    title: 'Water',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'water-reminder',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

type Shared = {
  settings: { isEnabled: boolean; goalMl: number; thirstMinutes: number; isSoundOn: boolean }
  today: { day: string; drinks: { at: number; ml: number }[] }
  clock: { anchorAt: number; alertedAt: number | null; offUntil: number | null; heartbeatAt: number }
  log: { streak: number; streakDay: string | null }
}

function dayOf(ms: number): string {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A state file another session left behind: the last glass `minutesAgo`.
function file(minutesAgo: number, drinks: number[] = [], settings: Partial<Shared['settings']> = {}): string {
  const s: Shared = {
    settings: { isEnabled: true, goalMl: 2500, thirstMinutes: 60, isSoundOn: true, ...settings },
    today: { day: dayOf(START), drinks: drinks.map((ml, i) => ({ at: START - (minutesAgo + drinks.length - 1 - i) * MINUTE, ml })) },
    clock: { anchorAt: START - minutesAgo * MINUTE, alertedAt: null, offUntil: null, heartbeatAt: START - 10_000 },
    log: { streak: 0, streakDay: null },
  }

  return JSON.stringify(s)
}

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On, files: Record<string, string> = {}) {
  const toasts: string[] = []
  const sounds: unknown[] = []
  const status: (string | undefined)[] = []
  const opened: string[] = []
  const closed: string[] = []

  on('command.register', () => ({ value: { command: 'water' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('audio.play', (_, e) => {
    sounds.push(e.clip)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  // What the engine draws where the mod leaves a site alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const clock = mock.clock(on, { now: START })
  const saved = (): Shared => JSON.parse(files[FILE] ?? '{}') as Shared
  const reminders = () => toasts.filter(t => t.startsWith('Time for a glass of water'))

  return { clock, toasts, sounds, status, opened, closed, files, saved, reminders }
}

test('a fresh install starts at 2.5 L and an hour, on every surface', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(world.saved().settings).toEqual({ isEnabled: true, goalMl: 2500, thirstMinutes: 60, isSoundOn: true })
  expect(world.status.at(-1)).toBe('Water 0 / 2.5 L · 60m')
  expect(world.opened).toEqual(['water-reminder'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^0 \/ 2.5 L$/ })).toBeDefined()
    } else {
      expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Today 0 / 2.5 L')
    }
    expect((await ui.find({ key: 'glass-200' }))?.text).toMatch(/0\.2 L/)
    expect((await ui.find({ key: 'glass-400' }))?.text).toMatch(/0\.4 L/)
    expect((await ui.find({ key: 'glass-500' }))?.text).toMatch(/0\.5 L/)
    expect(await ui.find({ key: 'undo' })).toBeUndefined()
    await ui.unmount()
  }
})

test('glasses add up, the goal counts toward the streak, and undo takes one back', async ($, on) => {
  const world = engine(on, { [FILE]: file(10, [500, 500, 500, 500]) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(world.status.at(-1)).toBe('Water 2 / 2.5 L · 50m')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'glass-400' })
  expect(world.toasts.at(-1)).toBe('+0.4 L · 2.4 / 2.5 L today.')
  expect(world.status.at(-1)).toBe('Water 2.4 / 2.5 L · 60m')

  await pane.press({ key: 'glass-200' })
  expect(world.toasts.at(-1)).toBe('Daily goal reached: 2.6 / 2.5 L. Streak: 1 day.')
  expect(world.status.at(-1)).toBe('Water ✓ 2.6 / 2.5 L')
  expect(world.saved().log).toEqual({ streak: 1, streakDay: dayOf(START) })

  await pane.press({ key: 'undo' })
  expect(world.saved().today.drinks.map(d => d.ml)).toEqual([500, 500, 500, 500, 400])
  expect(world.saved().log.streak).toBe(0)
  await pane.unmount()

  expect((await $.command.run({ ...TYPED, command: 'water', args: '0.5' })).text).toBe('Daily goal reached: 2.9 / 2.5 L. Streak: 1 day.')
})

test('after an hour without a glass it reminds every five minutes until one is logged', async ($, on) => {
  const world = engine(on, { [FILE]: file(59, [330]) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(world.reminders()).toHaveLength(0)

  await world.clock.advance(MINUTE)
  expect(world.reminders()).toEqual(['Time for a glass of water! Nothing for 60 min, 0.33 / 2.5 L today.'])
  expect(world.sounds).toHaveLength(1)
  expect(world.status.at(-1)).toBe('DRINK WATER! nothing for 60 min · 0.33 / 2.5 L')
  expect(world.saved().clock.alertedAt).not.toBeNull()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /^DRINK WATER$/ })).toBeDefined()
    expect(await band.find({ key: 'band-200' })).toBeDefined()
    expect(await band.find({ key: 'band-500' })).toBeDefined()
    await band.unmount()
  }

  await world.clock.advance(4 * MINUTE)
  expect(world.reminders()).toHaveLength(1)
  await world.clock.advance(MINUTE)
  expect(world.reminders()).toHaveLength(2)
  await world.clock.advance(5 * MINUTE)
  expect(world.reminders()).toHaveLength(3)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-500' })
  expect(world.saved().clock.alertedAt).toBeNull()
  expect(await band.find({ key: 'band-500' })).toBeUndefined()
  await band.unmount()

  await world.clock.advance(30 * MINUTE)
  expect(world.reminders()).toHaveLength(3)
  expect(world.status.at(-1)).toBe('Water 0.83 / 2.5 L · 30m')
})

test('a glass logged in another session lifts the reminder here within 15 seconds', async ($, on) => {
  const world = engine(on, { [FILE]: file(61) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await world.clock.advance(15_000)
  expect(world.reminders()).toHaveLength(1)

  const elsewhere = world.saved()
  elsewhere.today.drinks.push({ at: START + 20_000, ml: 330 })
  elsewhere.clock = { ...elsewhere.clock, anchorAt: START + 20_000, alertedAt: null }
  world.files[FILE] = JSON.stringify(elsewhere)

  await world.clock.advance(15_000)
  expect(world.status.at(-1)).toBe('Water 0.33 / 2.5 L · 60m')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
  await band.unmount()
})

test('another session already reminded: this one stays quiet for five minutes', async ($, on) => {
  const stale = JSON.parse(file(61)) as Shared
  stale.clock.alertedAt = START - 2 * MINUTE
  const world = engine(on, { [FILE]: JSON.stringify(stale) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await world.clock.advance(2 * MINUTE)
  expect(world.reminders()).toHaveLength(0)
  await world.clock.advance(MINUTE)
  expect(world.reminders()).toHaveLength(1)
})

test('with the goal reached it stops reminding', async ($, on) => {
  const world = engine(on, { [FILE]: file(10, [500, 500, 500, 500, 500]) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await world.clock.advance(3 * 60 * MINUTE)

  expect(world.reminders()).toHaveLength(0)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^Daily goal reached/ })).toBeDefined()
  await pane.unmount()
})

test('the goal: presets, the stepper, a custom value, and never under 2 L', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'settings' })
  await pane.press({ key: 'preset-3000' })
  expect(world.saved().settings.goalMl).toBe(3000)

  await pane.press({ key: 'goal-more' })
  expect(world.saved().settings.goalMl).toBe(3250)
  expect(await pane.find({ type: 'Text', text: /^3\.25 L$/ })).toBeDefined()
  await pane.press({ key: 'goal-less' })
  await pane.press({ key: 'goal-less' })
  expect(world.saved().settings.goalMl).toBe(2750)

  await pane.input({ key: 'custom-goal', text: '3.6' })
  expect(world.saved().settings.goalMl).toBe(3600)
  await pane.input({ key: 'custom-goal', text: '1.5' })
  expect(world.saved().settings.goalMl).toBe(3600)
  expect(world.toasts.at(-1)).toBe('At least 2 L a day: the goal stays at 3.6 L.')

  await pane.press({ key: 'preset-2000' })
  await pane.press({ key: 'goal-less' })
  expect(world.saved().settings.goalMl).toBe(2000)
  await pane.unmount()

  expect((await $.command.run({ ...TYPED, command: 'water', args: 'goal 2.75' })).text).toBe('Daily goal: 2.75 L.')
  expect((await $.command.run({ ...TYPED, command: 'water', args: 'goal 1' })).text).toMatch(/^At least 2 L/)
})

test('mobile has no text field: the goal is set by preset and stepper there', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await pane.press({ key: 'settings' })
  expect(await pane.find({ key: 'preset-2500' })).toBeDefined()
  expect(await pane.find({ key: 'goal-more' })).toBeDefined()
  expect(await pane.find({ key: 'custom-goal' })).toBeUndefined()
  await pane.unmount()
})

test('the reminder delay can be set, by command and in the pane', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ ...TYPED, command: 'water', args: 'remind 45' })).text).toBe(
    'Reminder after 45 min without a glass, then every 5 min.',
  )
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'settings' })
  await pane.press({ key: 'thirst-less' })
  expect(world.saved().settings.thirstMinutes).toBe(30)
  await pane.unmount()

  await world.clock.advance(30 * MINUTE)
  expect(world.reminders()).toHaveLength(1)
})

test('a gap with no session alive starts the thirst clock over', async ($, on) => {
  const stale = JSON.parse(file(90)) as Shared
  stale.clock.heartbeatAt = START - 45 * MINUTE
  const world = engine(on, { [FILE]: JSON.stringify(stale) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(world.saved().clock.anchorAt).toBe(START)
  expect(world.status.at(-1)).toBe('Water 0 / 2.5 L · 60m')
})

test('a new day starts with no glasses', async ($, on) => {
  const old = JSON.parse(file(10, [500, 500])) as Shared
  old.today.day = '2020-01-01'
  const world = engine(on, { [FILE]: JSON.stringify(old) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(world.saved().today).toEqual({ day: dayOf(START), drinks: [] })
})

test('/water off turns it off in every session until /water on, and pause holds it', async ($, on) => {
  const world = engine(on, { [FILE]: file(61) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ ...TYPED, command: 'water', args: 'off' })).text).toBe(
    'Water reminder is off in every session, until /water on.',
  )
  expect(world.status.at(-1)).toBeUndefined()
  expect(world.closed).toEqual(['water-reminder'])
  await world.clock.advance(2 * 60 * MINUTE)
  expect(world.reminders()).toHaveLength(0)

  expect((await $.command.run({ ...TYPED, command: 'water', args: 'on' })).text).toBe('Water reminder is on. The clock starts now.')
  expect((await $.command.run({ ...TYPED, command: 'water', args: 'pause 2h' })).text).toMatch(/^Reminders paused until \d\d:\d\d/)
  await world.clock.advance(90 * MINUTE)
  expect(world.reminders()).toHaveLength(0)
  expect(world.status.at(-1)).toMatch(/paused until/)

  // The pause runs out and the hour starts then.
  await world.clock.advance(30 * MINUTE + 15_000)
  expect(world.status.at(-1)).toBe('Water 0 / 2.5 L · 60m')
  expect((await $.command.run({ ...TYPED, command: 'water', args: 'later' })).text).toMatch(/^Usage:/)
})

test('a headless run with nobody attached never reminds', async ($, on) => {
  const world = engine(on, { [FILE]: file(61) })
  on('session.surfaces', () => ({ value: [] }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await world.clock.advance(10 * MINUTE)
  expect(world.reminders()).toHaveLength(0)
  expect(world.sounds).toHaveLength(0)
})
