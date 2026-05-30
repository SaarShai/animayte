/*
 * animayte · events — the session-event vocabulary (C6), shared by the daemon and
 * the offline simulator so classification can't drift between them.
 *
 * classifyTool(tool, input) maps a Claude Code PreToolUse into one of the animation
 * EVENTS the manifest's `reactions` map understands (Reading/Searching/…). Bash is
 * sub-classified by its command (test / install / git / generic run). Pure + testable.
 */

export const TOOL_EVENTS = ['Reading', 'Searching', 'Writing', 'Running', 'Testing', 'Installing', 'Committing'];

const INSTALL = /(^|\s|&&|\||;)(npm (i|ci|install)|pnpm (i|add|install)|yarn( add| install)?|bun (i|add|install)|pip3? install|brew install|apt(-get)? install|cargo add|go get|gem install)\b/;
const TEST = /\b(npm (t|test)|npm run test|yarn test|pnpm test|jest|vitest|pytest|mocha|go test|cargo test|rspec|phpunit|ctest)\b/;
const GIT = /(^|\s|&&|\||;)git\s+(commit|push|add|tag|merge|rebase|cherry-pick)\b/;

/** → { event, category } (event matches manifest.reactions) or null (generic "thinking"). */
export function classifyTool(tool, input) {
  const t = String(tool || '');
  if (/^(Read|NotebookRead|ReadFile)$/.test(t)) return { event: 'Reading', category: 'read' };
  if (/^(Grep|Glob|WebSearch|WebFetch|Search)$/.test(t)) return { event: 'Searching', category: 'search' };
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Update|ApplyPatch)$/.test(t)) return { event: 'Writing', category: 'edit' };
  if (t === 'Bash' || t === 'Shell') {
    const cmd = String((input && (input.command || input.cmd || input.script)) || '').toLowerCase();
    if (INSTALL.test(cmd)) return { event: 'Installing', category: 'install' };
    if (TEST.test(cmd)) return { event: 'Testing', category: 'test' };
    if (GIT.test(cmd)) return { event: 'Committing', category: 'git' };
    return { event: 'Running', category: 'run' };
  }
  return null;
}
