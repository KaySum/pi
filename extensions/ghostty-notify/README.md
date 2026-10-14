# ghostty-notify

Sends a desktop notification when Pi is done, so you can look away while it works. It
is posted by Ghostty, so clicking it brings Ghostty forward. It has no dependencies or
install step.

## The command

`/notify` toggles notifications; `/notify on` and `/notify off` set them. They start off
in each Pi, and the setting survives `/reload` but not a restart.

## When it notifies

When a run is over: after any retries, compaction or queued messages, not at the first
pause. A run you stopped with Escape does not notify, and neither does Pi outside its
terminal interface (print, JSON or RPC mode), where the escape sequence would end up in
the output.

The notification reads `Done in <project folder>`, and macOS plays Funk at the alert
volume set in System Settings → Sound (75% while it has never been changed). `SOUND` at
the top of [`index.ts`](index.ts) picks another file; `afplay` plays any audio format.

## Inside Neovim

Neovim's `:terminal` swallows the escape sequence a program uses to ask for a
notification, so when Pi runs inside Neovim it asks that Neovim to pass it on to
Ghostty instead ([`notify.lua`](notify.lua)). The next time Neovim gains focus it shows
Pi: through [sidekick.nvim](https://github.com/folke/sidekick.nvim) when Pi runs in a
sidekick session, which opens its window if hidden, else by switching to Pi's terminal
window or buffer. Either way it enters terminal mode. There is no jump when you were in
Pi's buffer as it finished, or once you have gone there yourself.

## Limits

- **Ghostty only, as tested.** The notification is OSC 777, which WezTerm and rxvt-unicode
  also understand. iTerm2 and kitty use other sequences and show nothing; Apple's
  Terminal only plays the sound.
- **Not while Ghostty is in front.** Ghostty does not show its own notifications while it
  is the active app, on any tab; the sound still plays.
- **The click does not pick the tab.** It brings Ghostty forward without switching to the
  tab Pi is in.
- **Not inside tmux**, which swallows the sequence the way Neovim does.
- **Ghostty must be allowed to notify**, in System Settings → Notifications.
- **The sound needs macOS** and is skipped elsewhere.
- **`/notify` stays in the input history.** Pi records every extension command there and
  offers no way out of it.
