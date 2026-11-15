/**
 * System tray icon.
 *
 * Fork note: upstream drew the Windows tray icon by writing a script to the
 * temp folder and running it in a hidden shell with relaxed script policy.
 * Antivirus behaviour engines treat that as a dropper, so this fork ships no
 * tray at all: the console window shows RaceIQ is running, and closing it (or
 * Start menu → "Encerrar RaceIQ") stops the app.
 */
export function shouldStartTray(
  _platform: NodeJS.Platform = process.platform,
  _env: NodeJS.ProcessEnv = process.env,
): boolean {
  return false;
}

export function startTray(_url: string): void {
  // Intentionally empty — see the note above.
}
