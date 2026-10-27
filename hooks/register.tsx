import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WaterShared } from '../types'
import {
  GLASSES,
  MINUTE,
  MIN_GOAL_ML,
  NAG_MS,
  PRESETS,
  GOAL_STEP,
  THIRST,
  addDrink,
  checkIn,
  drunk,
  fresh,
  liters,
  markAlerted,
  parseAmount,
  parseDuration,
  parseShared,
  pauseUntil,
  phaseOf,
  progress,
  setEnabled,
  setGoal,
  setThirst,
  shouldAlert,
  thirstyAt,
  timeOfDay,
  undoDrink,
} from './model'

const PANE = 'water-reminder'
const TITLE = 'Water'
const CHIME = 'sounds/chime.wav'
const SYNC_MS = 15_000
const DEFAULT_OFF_MS = 60 * MINUTE
const WATER = '#0EA5E9'

const shared = atom({ plugin: 'water-reminder', key: 'shared' } as const, fresh(0))
const now = atom({ plugin: 'water-reminder', key: 'now' } as const, 0)
const isSettingsOpen = atom({ plugin: 'water-reminder', key: 'isSettingsOpen' } as const, false)

// Module variables start over on a hot reload; session.start sets them again.
let syncer: Timer | undefined
let statePath: string | undefined
let lastStatus: string | undefined
let isAlerting = false
let isInteractive = true

// The day's glasses live in a file of their own, not `$.store`: every session
// reads and writes the same count and the same thirst clock.
async function pathOf($: EngineInterface): Promise<string> {
  if (statePath !== undefined) return statePath
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  statePath = `${configDir ?? `${home ?? '.'}/.claude`}/water-reminder.json`

  return statePath
}

async function load($: EngineInterface, t: number): Promise<WaterShared> {
  const text = await $.fs.read(await pathOf($)).catch(() => undefined)

  return parseShared(typeof text === 'string' ? text : undefined, t)
}

// Read, change, write back, then publish to this session's drawings. Two
// sessions writing in the same instant is the one race: the later one wins.
async function change($: EngineInterface, fn: (s: WaterShared, t: number) => WaterShared): Promise<WaterShared> {
  const t = await $.clock.now()
  const next = fn(await load($, t), t)
  await $.fs.write(await pathOf($), `${JSON.stringify(next, null, 2)}\n`)
  await publish($, next, t)

  return next
}

async function publish($: EngineInterface, s: WaterShared, t: number): Promise<void> {
  await update($, shared, () => s)
  await update($, now, () => t)
  showStatus(s, t, $)
}

function bar(p: number, width: number): string {
  const filled = Math.min(width, Math.floor(p * width))

  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

function minutesSince(s: WaterShared, t: number): number {
  return Math.max(0, Math.floor((t - s.clock.anchorAt) / MINUTE))
}

function amount(s: WaterShared): string {
  return `${liters(drunk(s))} / ${liters(s.settings.goalMl)} L`
}

function statusText(s: WaterShared, t: number): string | undefined {
  const phase = phaseOf(s, t)
  if (phase === 'disabled') return undefined
  if (phase === 'off') return `Water ${amount(s)} · paused until ${timeOfDay(s.clock.offUntil ?? t)}`
  if (phase === 'reached') return `Water ✓ ${amount(s)}`
  if (phase === 'thirsty') return `DRINK WATER! nothing for ${minutesSince(s, t)} min · ${amount(s)}`

  return `Water ${amount(s)} · ${Math.ceil((thirstyAt(s) - t) / MINUTE)}m`
}

function showStatus(s: WaterShared, t: number, $: EngineInterface): void {
  const text = statusText(s, t)
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

function chime($: EngineInterface, s: WaterShared): void {
  if (s.settings.isSoundOn) void $.audio.play({ asset: CHIME }).catch(() => undefined)
}

async function sync($: EngineInterface): Promise<void> {
  const s = await change($, checkIn)
  if (shouldAlert(s, await $.clock.now())) await alert($)
}

// Raised by whichever session gets there first: it writes `alertedAt`, and
// the others see it on their next check and stay quiet for five minutes. A
// `claude -p` run or an SDK job with nothing attached never claims it.
async function alert($: EngineInterface): Promise<void> {
  if (isAlerting) return
  if (!isInteractive && (await $.session.surfaces()).length === 0) return
  isAlerting = true
  try {
    let isMine = false
    const s = await change($, (c, t) => {
      isMine = shouldAlert(c, t)

      return isMine ? markAlerted(c, t) : c
    })
    if (!isMine) return

    const t = await $.clock.now()
    const text = `Time for a glass of water! Nothing for ${minutesSince(s, t)} min, ${amount(s)} today.`
    chime($, s)
    $.ui.toast(text, { timeoutMs: 30_000 })
    void $.ui.notify(text, { title: TITLE }).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })
  } finally {
    isAlerting = false
  }
}

async function drink($: EngineInterface, ml: number): Promise<string> {
  const before = await read($, shared)
  const s = await change($, (c, t) => addDrink(c, ml, t))
  const isNewlyReached = drunk(before) < before.settings.goalMl && drunk(s) >= s.settings.goalMl
  const text = isNewlyReached
    ? `Daily goal reached: ${amount(s)}. Streak: ${s.log.streak} ${s.log.streak === 1 ? 'day' : 'days'}.`
    : `+${liters(ml)} L · ${amount(s)} today.`
  $.ui.toast(text, { timeoutMs: 5000 })

  return text
}

async function undo($: EngineInterface): Promise<string> {
  let removed: number | undefined
  const s = await change($, (c, t) => {
    const r = undoDrink(c, t)
    removed = r.removed?.ml

    return r.next
  })

  return removed === undefined ? 'Nothing logged today yet.' : `Took back ${liters(removed)} L · ${amount(s)} today.`
}

async function goal($: EngineInterface, ml: number | undefined): Promise<string> {
  if (ml === undefined) return 'Could not read that goal. Examples: 2.5 · 3 L · 2750 ml.'
  if (ml < MIN_GOAL_ML) return `At least ${liters(MIN_GOAL_ML)} L a day: the goal stays at ${liters((await read($, shared)).settings.goalMl)} L.`
  const s = await change($, (c, t) => setGoal(c, ml, t))

  return `Daily goal: ${liters(s.settings.goalMl)} L.`
}

async function setSwitch($: EngineInterface, isEnabled: boolean): Promise<string> {
  await change($, (c, t) => setEnabled(c, isEnabled, t))
  if (!isEnabled) await $.ui.close({ id: PANE }).catch(() => undefined)

  return isEnabled
    ? 'Water reminder is on. The clock starts now.'
    : 'Water reminder is off in every session, until /water on.'
}

function describe(s: WaterShared, t: number): string {
  const phase = phaseOf(s, t)
  const glasses = `${s.today.drinks.length} ${s.today.drinks.length === 1 ? 'glass' : 'glasses'}`
  if (phase === 'disabled') return 'Water reminder is off. /water on turns it back on.'
  if (phase === 'off') return `Paused until ${timeOfDay(s.clock.offUntil ?? t)}. ${amount(s)} today (${glasses}).`
  if (phase === 'reached') return `Daily goal reached: ${amount(s)} (${glasses}). Streak: ${s.log.streak} days.`
  if (phase === 'thirsty') return `Nothing for ${minutesSince(s, t)} min! ${amount(s)} today. /water 400 logs a glass.`

  return `${amount(s)} today (${glasses}). Next reminder at ${timeOfDay(thirstyAt(s))} unless you drink before then.`
}

const USAGE = [
  'Usage: /water [200|400|500|0.5|goal 2.5|remind 45|undo|pause [1h]|on|off|sound on|off]',
  '  /water             status, and opens the pane',
  '  /water 400         log a 0.4 L glass',
  '  /water goal 2.5    daily goal in litres (at least 2)',
  '  /water remind 45   remind after 45 min without a glass',
  '  /water pause 2h    pause reminders for two hours',
  '  /water off         off in every session, until /water on',
].join('\n')

async function boot($: EngineInterface): Promise<void> {
  if (syncer !== undefined) return
  syncer = $.clock.every(SYNC_MS, () => {
    void sync($).catch(err => $.ui.log(`water-reminder: sync failed: ${String(err)}`, { to: 'debug' }))
  })
  const s = await change($, checkIn)
  if (s.settings.isEnabled) void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'water',
      description: 'Water: log a glass, show today, set the daily goal and the reminder',
      argumentHint: '[200|400|500|goal 2.5|remind 45|undo|pause 1h|on|off]',
      immediate: true,
    })
    isInteractive = e.isInteractive
    await boot($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await boot($)

    return next(e)
  })

  on('command.run', { command: 'water' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    const [word = '', ...rest] = args.split(/\s+/)
    const value = rest.join(' ')

    if (word === '' || word === 'status') {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const text = describe(await read($, shared), await $.clock.now())

      return { text: opened.isPlaced ? text : `${text} The pane is waiting for room: ${opened.reason}` }
    }
    if (word === 'on') return { text: await setSwitch($, true) }
    if (word === 'off' && value === '') return { text: await setSwitch($, false) }
    if (word === 'pause' || (word === 'off' && value !== '')) {
      const ms = parseDuration(value || '1h') ?? DEFAULT_OFF_MS
      const s = await change($, (c, t) => pauseUntil(c, t + ms))

      return { text: `Reminders paused until ${timeOfDay(s.clock.offUntil ?? 0)}. /water on resumes them.` }
    }

    const s = await read($, shared)
    if (!s.settings.isEnabled) return { text: 'Water reminder is off. /water on turns it back on.' }

    if (word === 'goal') return { text: await goal($, parseAmount(value)) }
    if (word === 'remind') {
      const minutes = Number(value.replace(/\s*min.*$/, ''))
      if (!Number.isFinite(minutes) || minutes <= 0) return { text: USAGE }
      const after = await change($, c => setThirst(c, minutes))

      return { text: `Reminder after ${after.settings.thirstMinutes} min without a glass, then every ${NAG_MS / MINUTE} min.` }
    }
    if (word === 'undo') return { text: await undo($) }
    if (word === 'sound' && (value === 'on' || value === 'off')) {
      const isOn = value === 'on'
      await change($, c => ({ ...c, settings: { ...c.settings, isSoundOn: isOn } }))

      return { text: `Sound ${isOn ? 'on' : 'off'}.` }
    }
    const ml = parseAmount(args)
    if (ml !== undefined && ml >= 50 && ml <= 2000) return { text: await drink($, ml) }

    return { text: USAGE }
  })

  // While thirsty, a band above the prompt in every session, with the glasses
  // one key away. It goes the moment any session logs a glass.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, shared)
    const t = await read($, now)
    if (phaseOf(s, t) !== 'thirsty') return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text color="warning" bold>
          DRINK WATER
        </Text>
        <Text>
          nothing for {minutesSince(s, t)} min · {amount(s)}
        </Text>
        {GLASSES.map((ml, i) => (
          <Button
            key={`band-${ml}`}
            label={`${liters(ml)} L`}
            hotkey={String(i + 1)}
            variant={i === 1 ? 'primary' : undefined}
            onPress={() => void drink($, ml)}
          />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, shared)
    const t = await read($, now)
    const isOpen = await read($, isSettingsOpen)
    const phase = phaseOf(s, t)
    const width = Math.max(12, Math.min(28, e.props.bodyColumns - 4))

    if (phase === 'disabled') {
      return (
        <Box flexDirection="column" gap={1} paddingY={1} alignItems="center">
          <Text dimColor>Water reminder is off in every session.</Text>
          <Button key="enable" label="Turn on" variant="primary" onPress={() => void setSwitch($, true)} />
        </Box>
      )
    }

    let gauge
    if (e.surface === 'terminal') {
      gauge = (
        <Box flexDirection="column" alignItems="center">
          <Text bold>{amount(s)}</Text>
          <Text color="suggestion">{bar(progress(s), width)}</Text>
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve(e)
      gauge = <Svg source={glass(progress(s), liters(drunk(s)), liters(s.settings.goalMl))} alt={`Today ${amount(s)}`} width={160} height={190} />
    }

    let line
    if (phase === 'thirsty') {
      line = (
        <Text color="warning" bold>
          Nothing for {minutesSince(s, t)} min: drink a glass!
        </Text>
      )
    } else if (phase === 'reached') {
      line = <Text color="success">Daily goal reached. More is fine too.</Text>
    } else if (phase === 'off') {
      line = <Text dimColor>Reminders paused until {timeOfDay(s.clock.offUntil ?? t)}.</Text>
    } else {
      line = (
        <Text dimColor>
          Last glass {minutesSince(s, t)} min ago · reminder at {timeOfDay(thirstyAt(s))}
        </Text>
      )
    }

    let settings
    if (isOpen) {
      let custom
      if (e.surface !== 'mobile') {
        const { Input } = $.ui.resolve(e)
        custom = (
          <Box width={Math.max(12, Math.min(30, e.props.bodyColumns - 4))}>
            <Input
              key="custom-goal"
              placeholder="Custom goal, e.g. 3.5"
              submitLabel="set"
              onSubmit={text => void goal($, parseAmount(text)).then(said => $.ui.toast(said, { timeoutMs: 5000 }))}
            />
          </Box>
        )
      }
      settings = (
        <Box flexDirection="column" gap={1} alignItems="center">
          <Text bold>Daily goal</Text>
          <Box flexDirection="row" gap={1} justifyContent="center" flexWrap="wrap">
            {PRESETS.map(ml => (
              <Button
                key={`preset-${ml}`}
                label={`${liters(ml)} L`}
                variant={s.settings.goalMl === ml ? 'primary' : undefined}
                onPress={() => void goal($, ml)}
              />
            ))}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="goal-less" label="−" onPress={() => void goal($, Math.max(MIN_GOAL_ML, s.settings.goalMl - GOAL_STEP))} />
            <Box width={8} justifyContent="center">
              <Text tabular>{liters(s.settings.goalMl)} L</Text>
            </Box>
            <Button key="goal-more" label="+" onPress={() => void goal($, s.settings.goalMl + GOAL_STEP)} />
          </Box>
          {custom}
          <Text bold>Remind after</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="thirst-less" label="−" onPress={() => void nudgeThirst($, -1)} />
            <Box width={8} justifyContent="center">
              <Text tabular>{s.settings.thirstMinutes} min</Text>
            </Box>
            <Button key="thirst-more" label="+" onPress={() => void nudgeThirst($, 1)} />
          </Box>
          <Text dimColor wrap="wrap">
            without a glass, then every {NAG_MS / MINUTE} min until you drink
          </Text>
          <Box flexDirection="row" gap={1} justifyContent="center" flexWrap="wrap">
            <Button
              key="sound"
              label={s.settings.isSoundOn ? 'Sound on' : 'Sound off'}
              plain
              dimColor={!s.settings.isSoundOn}
              onPress={() => void change($, c => ({ ...c, settings: { ...c.settings, isSoundOn: !c.settings.isSoundOn } }))}
            />
            <Button key="pause" label="Pause 1 h" plain onPress={() => void change($, (c, at) => pauseUntil(c, at + DEFAULT_OFF_MS))} />
          </Box>
          <Button key="disable" label="Turn off everywhere" onPress={() => void setSwitch($, false)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingY={1} alignItems="center">
        {gauge}
        {line}
        <Box flexDirection="row" gap={1} justifyContent="center" flexWrap="wrap">
          {GLASSES.map((ml, i) => (
            <Button
              key={`glass-${ml}`}
              label={`+ ${liters(ml)} L`}
              hotkey={String(i + 1)}
              variant={phase === 'thirsty' ? 'primary' : undefined}
              onPress={() => void drink($, ml)}
            />
          ))}
        </Box>
        {s.today.drinks.length > 0 && (
          <Box flexDirection="row" justifyContent="center">
            <Button key="undo" label="Undo" plain dimColor onPress={() => void undo($)} />
          </Box>
        )}
        <Box flexDirection="row" gap={e.surface === 'terminal' ? 3 : 1} alignItems="center" justifyContent="center" flexWrap="wrap">
          <Text dimColor>
            {s.today.drinks.length} {s.today.drinks.length === 1 ? 'glass' : 'glasses'} · streak {s.log.streak}
            {phase === 'off' ? '' : ` · ${s.settings.thirstMinutes} min`}
          </Text>
          <Button
            key="settings"
            label={isOpen ? 'Done' : 'Adjust'}
            plain
            dimColor
            onPress={() => void update($, isSettingsOpen, o => !o)}
          />
        </Box>
        {settings}
      </Box>
    )
  })
}

async function nudgeThirst($: EngineInterface, direction: 1 | -1): Promise<void> {
  await change($, c => {
    const step = THIRST.step
    // Snap to the step grid, so 50 goes to 60 or 45.
    const minutes = direction > 0 ? Math.floor(c.settings.thirstMinutes / step) * step + step : Math.ceil(c.settings.thirstMinutes / step) * step - step

    return setThirst(c, minutes)
  })
}

// A glass filling up, for surfaces that draw SVG; text colours follow the
// system theme, since an SVG image cannot read the app's theme keys.
function glass(p: number, drank: string, goalL: string): string {
  const top = 22
  const bottom = 158
  const height = bottom - top
  const level = bottom - height * p
  // The glass narrows towards its foot: x at the rim 30..130, at the base 44..116.
  const edge = (y: number) => 30 + (14 * (y - top)) / height
  const water =
    p <= 0
      ? ''
      : `<path d="M${edge(level).toFixed(1)} ${level.toFixed(1)} L${(160 - edge(level)).toFixed(1)} ${level.toFixed(1)} L116 ${bottom} L44 ${bottom} Z" fill="${WATER}" opacity="0.85"/>`

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="190" viewBox="0 0 160 190">',
    '<style>',
    '.big{fill:#1d1d1f;font:600 20px -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;font-variant-numeric:tabular-nums}',
    '.cap{fill:#6e6e73;font:500 12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}',
    '.rim{stroke:#86868b}',
    '@media (prefers-color-scheme:dark){.big{fill:#f5f5f7}.cap{fill:#a1a1a6}.rim{stroke:#a1a1a6}}',
    '</style>',
    water,
    `<path class="rim" d="M30 ${top} L44 ${bottom} L116 ${bottom} L130 ${top}" fill="none" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
    `<text x="80" y="${bottom + 22}" text-anchor="middle" class="big">${drank} / ${goalL} L</text>`,
    `<text x="80" y="14" text-anchor="middle" class="cap">${Math.round(p * 100)} %</text>`,
    '</svg>',
  ].join('')
}
