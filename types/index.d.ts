export type WaterSettings = {
  /** The master switch: off, the mod shows nothing and reminds of nothing, in every session. */
  isEnabled: boolean
  /** The day's goal in millilitres, 2000 at least. */
  goalMl: number
  /** Minutes without a glass before the reminders start. */
  thirstMinutes: number
  isSoundOn: boolean
}

export type Drink = {
  /** Epoch ms the glass was logged. */
  at: number
  ml: number
}

export type WaterDay = {
  /** Local day the drinks belong to, YYYY-MM-DD. */
  day: string
  drinks: Drink[]
}

export type WaterClock = {
  /** Epoch ms the thirst clock counts from: the last glass, or a fresh start. */
  anchorAt: number
  /** Epoch ms a session last raised the reminder; null since the last glass. */
  alertedAt: number | null
  /** Epoch ms reminders stay paused until; null while on. */
  offUntil: number | null
  /** Epoch ms any session last checked in. */
  heartbeatAt: number
}

export type WaterLog = {
  /** Days in a row the goal was reached. */
  streak: number
  /** The last day the goal was reached. */
  streakDay: string | null
}

/** What every session shares through the state file. */
export type WaterShared = {
  settings: WaterSettings
  today: WaterDay
  clock: WaterClock
  log: WaterLog
}

declare module 'claude-code' {
  interface PluginState {
    'water-reminder': {
      shared: WaterShared
      now: number
      isSettingsOpen: boolean
    }
  }
}
