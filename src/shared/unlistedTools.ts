// ─── Registered-but-unlisted MCP tools ───────────────────────────────────────
//
// Three diet cuts share one mechanism: a tool can stay REGISTERED (a
// tools/call still dispatches to it, so hard-coded callers keep working)
// while being dropped from every profile's tools/list, which is the budget
// every session pays before it does any work.
//
//   1. a2a_task_send — a literal alias of send_message (one handler, one
//      shape). Agents should learn send_message; prompts and worker
//      instructions that still name the alias keep working.
//   2. Seven browser_repl sub-steps — already callable inside a snippet as
//      `await browser.X(args)`; as standalone tools they only duplicate the
//      bridge. The browser_repl description carries the argument cheat
//      sheet, and a wrong-argument call inside a snippet reports the valid
//      argument names.
//   3. Pre-merge names — browser_session_{start,stop,status,list} collapsed
//      into browser_session {action}, pane_{set,get}_metadata into
//      pane_metadata {action}, and pane_unstash into pane_stash {restore}.
//      The merged tools are listed; these names stay callable for one
//      release, then the registrations are removed.
//
// Every name here MUST still be registered in every profile that had it
// before (the core/commander manifests keep them); only the listing drops.
// The raw protocol probe pins the listed surface, so a name that leaks back
// into tools/list fails the baseline.

/** Tool names kept callable via tools/call but absent from tools/list. */
export const UNLISTED_TOOLS: readonly string[] = Object.freeze([
  // a2a_task_send === send_message (same handler + shape).
  'a2a_task_send',
  // browser_repl sub-steps (reachable as `await browser.X(args)` inside a
  // snippet; see BROWSER_REPL_TOOLS).
  'browser_navigate_back',
  'browser_hover',
  'browser_drag',
  'browser_select',
  'browser_scroll_into_view',
  'browser_highlight',
  'browser_dialog',
  // Pre-merge names, deprecated for one release after their merged tools
  // landed (browser_session / pane_metadata / pane_stash {restore}).
  'browser_session_start',
  'browser_session_stop',
  'browser_session_status',
  'browser_session_list',
  'pane_set_metadata',
  'pane_get_metadata',
  'pane_unstash',
]);

export const UNLISTED_TOOLS_SET: ReadonlySet<string> = new Set(UNLISTED_TOOLS);
