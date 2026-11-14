// Fork note: the shell-script helpers that lived here are gone. Their callers
// now use in-process Win32 APIs (see win32-native.ts) so the app never spawns
// hidden shells in the background.

export const IS_WINDOWS = process.platform === "win32";
export const IS_DARWIN = process.platform === "darwin";
