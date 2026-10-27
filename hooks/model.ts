// The shared water state as plain data and pure functions of it, so `change`
// may run any of them on what another session wrote and the tests can reason
// about them.

import type { Drink, WaterClock, WaterDay, WaterLog, WaterSettings, WaterShared } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** The glasses, European sizes. */
export const GLASSES = [200, 330, 500] as const

/** Nobody should drink less than this a day. */
export const MIN_GOAL_ML = 2000
export const MAX_GOAL_ML = 8000
export const PRESETS = [2000, 2500, 3000] as const
/** What the goal's − and + move it by. */
export const GOAL_STEP = 250

export const THIRST = { min: 15, max: 180, step: 15 }
export const DEFAULTS: WaterSettings = { isEnabled: true, goalMl: 2500, thirstMinutes: 60, isSoundOn: true }

/** While thirsty, the reminder comes back this often until a glass is logged. */
export const NAG_MS = 5 * MINUTE
/** No session checked in for this long: nobody was at Claude Code, the thirst clock starts over. */
export const AWAY_GAP_MS = 30 * MINUTE

export type Phase = 'disabled' | 'off' | 'reached' | 'fine' | 'thirsty'

export function dayOf(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')

  return `${d.getFullYear()}-${mm}-${dd}`
}

export function timeOfDay(ms: number): string {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `2500` → `2.5`, `330` → `0.33`. */
export function liters(ml: number): string {
  return String(Math.round(ml / 10) / 100)
}

export function clampGoal(ml: number): number {
  return Math.min(MAX_GOAL_ML, Math.max(MIN_GOAL_ML, Math.round(ml / 10) * 10))
}

export function clampThirst(minutes: number): number {
  return Math.min(THIRST.max, Math.max(THIRST.min, Math.round(minutes)))
}

/**
 * Reads an amount as typed: `2.5`, `2,5 l`, `0.33` are litres; `330`,
 * `2500 ml` are millilitres. Undefined for anything else.
 */
export function parseAmount(text: string): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)\s*(l|liter|litre|ml)?$/i.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1]!.replace(',', '.'))
  const unit = match[2]?.toLowerCase()
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (unit === 'ml') return Math.round(value)
  if (unit !== undefined) return Math.round(value * 1000)

  // Without a unit, small numbers are litres and large ones millilitres.
  return value < 20 ? Math.round(value * 1000) : Math.round(value)
}

/** Parses `2h`, `90m`, `30` (minutes) into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)\s*(h|hr|hours?|m|min|minutes?)?$/i.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1]!.replace(',', '.'))
  const unit = (match[2] ?? 'm').toLowerCase()
  const isHours = unit.startsWith('h')

  return Math.round(value * (isHours ? HOUR : MINUTE))
}

export function fresh(now: number, settings: WaterSettings = DEFAULTS): WaterShared {
  return {
    settings,
    today: { day: dayOf(now), drinks: [] },
    clock: { anchorAt: now, alertedAt: null, offUntil: null, heartbeatAt: now },
    log: { streak: 0, streakDay: null },
  }
}

export function drunk(s: WaterShared): number {
  return s.today.drinks.reduce((sum, d) => sum + d.ml, 0)
}

/** How much of the goal is in, 0 to 1. */
export function progress(s: WaterShared): number {
  return Math.min(1, drunk(s) / s.settings.goalMl)
}

export function phaseOf(s: WaterShared, now: number): Phase {
  if (!s.settings.isEnabled) return 'disabled'
  if (s.clock.offUntil !== null && now < s.clock.offUntil) return 'off'
  if (drunk(s) >= s.settings.goalMl) return 'reached'

  return now - s.clock.anchorAt >= s.settings.thirstMinutes * MINUTE ? 'thirsty' : 'fine'
}

/** When the reminders start, unless a glass comes first. */
export function thirstyAt(s: WaterShared): number {
  return s.clock.anchorAt + s.settings.thirstMinutes * MINUTE
}

/** A new day starts with an empty glass count and a fresh thirst clock. */
export function withToday(s: WaterShared, now: number): WaterShared {
  const day = dayOf(now)
  if (s.today.day === day) return s

  return { ...s, today: { day, drinks: [] }, clock: { ...s.clock, anchorAt: now, alertedAt: null } }
}

export function addDrink(s: WaterShared, ml: number, now: number): WaterShared {
  const base = withToday(s, now)
  const wasReached = drunk(base) >= base.settings.goalMl
  const today: WaterDay = { ...base.today, drinks: [...base.today.drinks, { at: now, ml: Math.round(ml) }] }
  const next: WaterShared = { ...base, today, clock: { ...base.clock, anchorAt: now, alertedAt: null } }
  const isReached = drunk(next) >= next.settings.goalMl

  return !wasReached && isReached ? { ...next, log: reach(next.log, today.day, now) } : next
}

// The goal reached today: the streak goes on from yesterday, or starts at one.
function reach(log: WaterLog, day: string, now: number): WaterLog {
  if (log.streakDay === day) return log
  const yesterday = dayOf(now - 24 * HOUR)

  return { streak: log.streakDay === yesterday ? log.streak + 1 : 1, streakDay: day }
}

/** Takes back today's last glass; the thirst clock goes back to the one before it. */
export function undoDrink(s: WaterShared, now: number): { next: WaterShared; removed: Drink | undefined } {
  const base = withToday(s, now)
  const removed = base.today.drinks.at(-1)
  if (removed === undefined) return { next: base, removed }
  const drinks = base.today.drinks.slice(0, -1)
  const anchorAt = drinks.at(-1)?.at ?? removed.at
  const next = { ...base, today: { ...base.today, drinks }, clock: { ...base.clock, anchorAt } }
  // A goal no longer reached takes back today's place in the streak.
  const isStillReached = drunk(next) >= next.settings.goalMl
  if (isStillReached || next.log.streakDay !== base.today.day) return { next, removed }
  const streak = Math.max(0, next.log.streak - 1)

  return { next: { ...next, log: { streak, streakDay: streak === 0 ? null : dayOf(now - 24 * HOUR) } }, removed }
}

export function setGoal(s: WaterShared, ml: number, now: number): WaterShared {
  const next = { ...s, settings: { ...s.settings, goalMl: clampGoal(ml) } }

  return drunk(next) >= next.settings.goalMl ? { ...next, log: reach(next.log, next.today.day, now) } : next
}

export function setThirst(s: WaterShared, minutes: number): WaterShared {
  return { ...s, settings: { ...s.settings, thirstMinutes: clampThirst(minutes) } }
}

export function setEnabled(s: WaterShared, isEnabled: boolean, now: number): WaterShared {
  const settings = { ...s.settings, isEnabled }
  // Turning back on starts the thirst clock now rather than one long run out.
  const clock: WaterClock = isEnabled ? { ...s.clock, anchorAt: now, alertedAt: null, offUntil: null } : { ...s.clock, offUntil: null }

  return { ...s, settings, clock }
}

export function pauseUntil(s: WaterShared, until: number): WaterShared {
  return { ...s, clock: { ...s.clock, offUntil: until, alertedAt: null } }
}

/**
 * What a session finds when it checks in: a new day, a gap with no session
 * alive, or a pause that ran out starts the thirst clock over; then the
 * heartbeat is stamped.
 */
export function checkIn(s: WaterShared, now: number): WaterShared {
  let next = withToday(s, now)
  const wasAway = now - next.clock.heartbeatAt > AWAY_GAP_MS
  const pauseEnded = next.clock.offUntil !== null && now >= next.clock.offUntil

  if (pauseEnded || wasAway) {
    const anchorAt = Math.max(next.clock.anchorAt, now)
    next = { ...next, clock: { ...next.clock, anchorAt, alertedAt: null, offUntil: pauseEnded ? null : next.clock.offUntil } }
  }

  return { ...next, clock: { ...next.clock, heartbeatAt: now } }
}

/** Whether this moment should raise the reminder: thirsty, and not reminded in the last five minutes. */
export function shouldAlert(s: WaterShared, now: number): boolean {
  if (phaseOf(s, now) !== 'thirsty') return false

  return s.clock.alertedAt === null || now - s.clock.alertedAt >= NAG_MS
}

export function markAlerted(s: WaterShared, now: number): WaterShared {
  return { ...s, clock: { ...s.clock, alertedAt: now } }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function drinksOf(value: unknown): Drink[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return []
    const { at, ml } = d as { at?: unknown; ml?: unknown }

    return typeof at === 'number' && typeof ml === 'number' && ml > 0 ? [{ at, ml }] : []
  })
}

/** Reads the state file's JSON, filling in anything missing or malformed. */
export function parseShared(text: string | undefined, now: number): WaterShared {
  let raw: unknown
  try {
    raw = text === undefined ? undefined : JSON.parse(text)
  } catch {
    raw = undefined
  }
  if (typeof raw !== 'object' || raw === null) return fresh(now)
  const r = raw as {
    settings?: Record<string, unknown>
    today?: Record<string, unknown>
    clock?: Record<string, unknown>
    log?: Record<string, unknown>
  }
  const st = r.settings ?? {}
  const settings: WaterSettings = {
    isEnabled: bool(st.isEnabled, DEFAULTS.isEnabled),
    goalMl: clampGoal(num(st.goalMl, DEFAULTS.goalMl)),
    thirstMinutes: clampThirst(num(st.thirstMinutes, DEFAULTS.thirstMinutes)),
    isSoundOn: bool(st.isSoundOn, DEFAULTS.isSoundOn),
  }
  const base = fresh(now, settings)
  const td = r.today ?? {}
  const today: WaterDay = { day: typeof td.day === 'string' ? td.day : base.today.day, drinks: drinksOf(td.drinks) }
  const c = r.clock ?? {}
  const clock: WaterClock = {
    anchorAt: num(c.anchorAt, now),
    alertedAt: typeof c.alertedAt === 'number' ? c.alertedAt : null,
    offUntil: typeof c.offUntil === 'number' ? c.offUntil : null,
    heartbeatAt: num(c.heartbeatAt, now),
  }
  const l = r.log ?? {}
  const log: WaterLog = {
    streak: Math.max(0, Math.floor(num(l.streak, 0))),
    streakDay: typeof l.streakDay === 'string' ? l.streakDay : null,
  }

  return { settings, today, clock, log }
}
