const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { getClaudeDir, getQoderDir } = require('./ponytail-config');

const STATE_FILE = '.ponytail-active';

// ponytail: VS Code Copilot never sets COPILOT_PLUGIN_DATA — it only injects
// CLAUDE_PLUGIN_ROOT, pointed at an install path under .vscode/agent-plugins/
// (#528). Without this fallback isCopilot was false, so ponytail assumed
// native Claude Code and emitted the statusline nudge, which VS Code Copilot
// doesn't read.
function isVsCodeCopilotRoot(pluginRoot) {
  if (!pluginRoot) return false;
  return pluginRoot.split(/[\\/]+/).includes('agent-plugins') &&
    pluginRoot.toLowerCase().includes('.vscode');
}

const isCopilot = Boolean(process.env.COPILOT_PLUGIN_DATA) ||
  isVsCodeCopilotRoot(process.env.CLAUDE_PLUGIN_ROOT);
const isCodex = !isCopilot && Boolean(process.env.PLUGIN_DATA);
const isQoder = !isCopilot && !isCodex && Boolean(process.env.QODER_SESSION_ID);
// CodeBuddy (#854) loads the Claude-format plugin and sets CLAUDE_PLUGIN_ROOT
// too, but adds CODEBUDDY_PLUGIN_ROOT only for its own plugin hook processes.
const isCodeBuddy = !isCopilot && !isCodex && !isQoder && Boolean(process.env.CODEBUDDY_PLUGIN_ROOT);
// Cursor (#817): CURSOR_VERSION is set only in the environment Cursor builds
// for hook processes (Cursor 3.20.17 assigns it in exactly one place, the hook
// env builder), so it never leaks into a Claude Code session running inside
// Cursor's terminal. Cursor also sets it when it runs a Claude-format plugin's
// hooks next to CLAUDE_PLUGIN_ROOT, and it needs Cursor-shaped JSON either
// way, so this check comes after the hosts with their own data dirs.
const isCursor = !isCopilot && !isCodex && !isQoder && !isCodeBuddy && Boolean(process.env.CURSOR_VERSION);

let stateDir = getClaudeDir();
if (isCodex) stateDir = process.env.PLUGIN_DATA;
// COPILOT_PLUGIN_DATA is unset under VS Code Copilot, so fall back to
// getClaudeDir() rather than building a path from undefined.
if (isCopilot) stateDir = process.env.COPILOT_PLUGIN_DATA || getClaudeDir();
if (isQoder) stateDir = getQoderDir();
if (isCodeBuddy) stateDir = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy');
if (isCursor) stateDir = path.join(os.homedir(), '.cursor');

const statePath = path.join(stateDir, STATE_FILE);

// Claude Code hands every hook its project dir, so the live mode is kept per
// project and concurrent sessions in different repos stop overwriting each other
// (#662, #809). Hosts without it keep the single shared flag.
const projectDir = (process.env.CLAUDE_PROJECT_DIR || '').trim();
// Replacing separators with '_' aliases e.g. /work/a/b and /work/a_b (#662).
// Do not read old sanitized keys: they cannot be assigned to one project safely.
const projectStatePath = projectDir
  ? path.join(stateDir, 'ponytail-modes',
    createHash('sha256').update(path.normalize(projectDir)).digest('hex'))
  : null;

// A file per session under <state dir>/<dir>/, for hooks that know their session id.
const sessionFile = (dir, sessionId) =>
  /^[\w-]+$/.test(String(sessionId || '')) ? path.join(stateDir, dir, sessionId) : null;

// Claude Code passes session_id on stdin to every hook and to the statusline, so a
// hook that calls useSession() keeps the level per session: two sessions in the same
// repo keep their own levels. Without an id, the per-project and shared flags apply.
let sessionStatePath = null;
function useSession(sessionId) {
  sessionStatePath = sessionFile(path.join('ponytail-modes', 'session'), sessionId);
}

// Session levels and band picks outlive their sessions, so every session start sweeps
// the stale ones. Never throws: a sweep must not cost the session its ruleset.
// shortcut: age by mtime, which only moves on a switch, so a session that runs 30 days
// without one falls back to the project level on its next compaction.
const DAY = 24 * 60 * 60 * 1000;
function pruneSessionFiles(now = Date.now()) {
  for (const [dir, maxAge] of [
    [path.join(stateDir, 'ponytail-modes', 'session'), 30 * DAY],
    // A pick nobody followed with a prompt is worth nothing a day later.
    [path.join(stateDir, 'ponytail-pending'), DAY],
  ]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      if (file === sessionStatePath) continue;
      // A sibling session starting at the same moment may delete it first.
      try {
        if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file);
      } catch (e) {}
    }
  }
}

// The project and shared flags are still written, for the statusline and for hooks
// and hosts without a session id.
function setMode(mode) {
  for (const file of [sessionStatePath, projectStatePath, statePath]) {
    if (file) setModeFile(file, mode);
  }
}

// A session's off is written as "off", not deleted: a missing session file falls
// back to the project flag, which another session may have set.
function clearMode() {
  if (sessionStatePath) setModeFile(sessionStatePath, 'off');
  for (const file of [projectStatePath, statePath]) {
    if (file) try { fs.unlinkSync(file); } catch (e) {}
  }
}

function setModeFile(file, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, mode);
}

// Live mode written by activate/mode-tracker: the session's own, else the project's,
// else the shared flag. Absent flag = ponytail off.
function readMode() {
  for (const file of [sessionStatePath, projectStatePath || statePath]) {
    if (!file) continue;
    try {
      return fs.readFileSync(file, 'utf8').trim() || null;
    } catch (e) {}
  }
  return null;
}

// A level picked in the band (hooks/band) waits in ponytail-pending/<session id> until
// the session's next prompt. Reading it consumes it; empty means the pick was taken back.
function takePendingMode(sessionId) {
  const file = sessionFile('ponytail-pending', sessionId);
  if (!file) return null;
  let mode = null;
  try {
    mode = fs.readFileSync(file, 'utf8').trim();
    fs.unlinkSync(file);
  } catch (e) {}
  return ['off', 'lite', 'full', 'ultra'].includes(mode) ? mode : null;
}

// Cursor's always-on project rule (.cursor/rules/ponytail.mdc) already puts the
// ruleset in front of every prompt and no hook can switch a rule off, so while
// it is in the workspace the hooks step back instead of injecting a second,
// possibly contradicting, copy (#817). Cursor hands every hook the workspace
// root as CURSOR_PROJECT_DIR; project hooks also run from that directory.
// ponytail: first workspace root only, a rule in a secondary folder of a
// multi-root workspace goes undetected.
function cursorRulePath() {
  const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const rule = path.join(root, '.cursor', 'rules', 'ponytail.mdc');
  return fs.existsSync(rule) ? rule : null;
}

function cursorRuleNotice(rule) {
  return 'PONYTAIL: the always-on Cursor rule ' + rule + ' is active in this workspace and ' +
    'already carries the ponytail ruleset, so the ponytail hooks injected nothing further. ' +
    'Mode switching (/ponytail lite|full|ultra|off, "stop ponytail") is unavailable while ' +
    'that rule exists. When the user tries to switch or turn off ponytail, tell them to ' +
    'delete that rule so hooks.json can manage the level.';
}

// Synchronous: every hook calls process.exit() right after this, and on macOS a pipe
// write is async, so a pending write died with the process (#1043).
function writeOut(text) {
  fs.writeSync(1, text);
}

function writeHookOutput(event, mode, context = '') {
  if (isCopilot) {
    // Copilot reads additionalContext on SessionStart; ignores output elsewhere.
    writeOut(JSON.stringify(
      event === 'SessionStart' && context ? { additionalContext: context } : {}));
    return;
  }
  if (isCodex) {
    // No systemMessage: Codex maps it to a yellow `warning:` entry (and de-greens the
    // completed-hook bullet), reading as an error every session (#605). The mode still
    // shows via the additionalContext "hook context:" line — active level when on,
    // "PONYTAIL MODE OFF" when off (that path passes context too).
    // ponytail: if openai/codex#16933 lands and hides additionalContext, restore a
    // non-warning mode signal here.
    const output = {};
    if (context) {
      output.hookSpecificOutput = {
        hookEventName: event,
        additionalContext: context,
      };
    }
    writeOut(JSON.stringify(output));
    return;
  }
  if (isQoder || isCodeBuddy) {
    // Qoder: hookSpecificOutput JSON, same shape as Codex minus systemMessage.
    // UserPromptSubmit additionalContext is injected into the Agent's conversation.
    // CodeBuddy would take raw stdout too, but also echoes it into the chat.
    const output = {};
    if (context) {
      output.hookSpecificOutput = {
        hookEventName: event,
        additionalContext: context,
      };
    }
    writeOut(JSON.stringify(output));
    return;
  }
  if (isCursor) {
    // Cursor parses stdout as JSON and treats empty stdout as "nothing to
    // say"; raw text would be logged as a parse error. sessionStart takes
    // additional_context into the conversation's system context;
    // beforeSubmitPrompt needs continue:true and, in Cursor 3.20.17, injects
    // additional_context into that turn (docs/cursor-hooks.md).
    if (!context) return;
    const output = { additional_context: context };
    if (event === 'UserPromptSubmit') output.continue = true;
    writeOut(JSON.stringify(output));
    return;
  }
  // Native Claude: SessionStart accepts raw stdout, but SubagentStart needs the
  // hookSpecificOutput JSON form or the context is dropped.
  if (event === 'SubagentStart') {
    writeOut(JSON.stringify(
      { hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
    return;
  }
  writeOut(context);
}

module.exports = {
  clearMode,
  cursorRuleNotice,
  cursorRulePath,
  isCodeBuddy,
  isCodex,
  isCopilot,
  isCursor,
  isQoder,
  readMode,
  setMode,
  pruneSessionFiles,
  takePendingMode,
  useSession,
  writeHookOutput,
};
