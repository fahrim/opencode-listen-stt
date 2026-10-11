/*
 * Server-side entry point.
 *
 * Dictation runs entirely in the terminal, but discovery goes through the
 * server: the CLI asks which plugins are active and loads the `./tui` export of
 * every plugin flagged `tui: true`. Without this file and that flag the TUI
 * half is never loaded.
 *
 * No imports on purpose — a local plugin can fail to load if it tries to
 * resolve packages while the server is booting.
 */
export default {
  id: "opencode-voice-99",
  tui: true,
  async setup() {},
};