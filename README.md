# water-reminder

A Claude Code mod that reminds you to drink water. Set a daily goal (2 L at least), log glasses of 0.2 L, 0.33 L or 0.5 L, and when you have gone too long without logging one, the mod reminds you every 5 minutes until you do.

The state is shared across all sessions: it lives in `~/.claude/water-reminder.json` (or under `$CLAUDE_CONFIG_DIR`), and every running session syncs with it every 15 seconds. A glass logged in one session ends the reminder in all the others.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install water-reminder --marketplace dariuszparys/claude-water-reminder
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first).

From a shell:

```bash
claude plugin install water-reminder --marketplace dariuszparys/claude-water-reminder
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dariuszparys/claude-water-reminder`, then Add plugin.

## How it works

- **Water pane**: the fill level, the three glass buttons (keys 1, 2, 3), Undo, and under Adjust the daily goal (2 / 2.5 / 3 L, − and + in steps of 0.25 L, a custom goal typed in), the reminder delay, sound, and the off switch.
- **Status line**: `Water 0.99 / 2.5 L · 37m`, the minutes until the first reminder.
- **Reminder**: after 60 min without a glass (adjustable, 15 to 180 min) a sound, a toast, a system notification and a band above the prompt with the glass buttons, then again every 5 minutes until a glass is logged.
- Once the daily goal is reached, the reminders stop for the day. A new day starts at midnight.
- If no session was open for 30 min, the clock starts over, so you are not reminded the moment you come back from lunch.

## Command

```
/water              status, and opens the pane
/water 330          log a glass (also 0.33 / 0.5 / 200)
/water goal 2.5     daily goal in litres, at least 2
/water remind 45    remind after 45 min without a glass
/water undo         take back the last glass
/water pause 2h     pause reminders
/water off | on     turn it off or on in every session
/water sound on|off the reminder's sound
```

## License

MIT, see [LICENSE](LICENSE).
