### Features
- Turn on a voice race engineer for Assetto Corsa Competizione (Settings → Sound, the sidebar button or Ctrl+Shift+E). While you drive it speaks short Brazilian Portuguese callouts: before your 2–3 costliest corners it gives the gear, the brake point in metres before turn-in and one fix (brake later/earlier, harder, trail-brake, carry more speed, earlier throttle); after a corner it says how much time you won or lost and why; at the line it gives the lap time against your previous best. The reference is your best pass through each corner, and it can also learn from AI cars on track, using their speed and brake points where they are faster. It stays silent from 150 m before each brake point until you are back on throttle. Replay a recording with `bun apps/backend/scripts/race-engineer/replay-acc.ts <recording> [--bots]`.
- Run RaceIQ in the native macOS app with existing lap data and saved network access; control login startup and whether closing the window quits the app.
- Choose DeepSeek for analysis, chat, auto-tune and driver profiles with its own API key. The model picker reads the models available to that key instead of using a fixed list, preselects `deepseek-flash`, keeps tool calls working, and only offers image attachments on models that accept them.

### Fixes
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.

### Internal
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
