#!/usr/bin/env node
// PreToolUse hook for the Bash tool (issue #1214), wired in .claude/settings.json.
//
// Blocks three commands CLAUDE.md forbids, each of which has cost real work:
//   - `gh issue|pr comment --edit-last` edits the newest comment of this
//     account -- after an answer, the human's.
//   - commit/push/branch switch in the MAIN checkout of this project, whose
//     single HEAD several runs share (docs/warum/worktree.md).
//   - `pnpm install|i|add` without --dir from a linked worktree, which rewrites
//     the main checkout's node_modules links relative to the worktree (#606).
//
// Exit 2 blocks the call and puts stderr in front of the model. Everything
// else -- including any error in here -- is exit 0: the guard fails open.
//
// Not a shell parser: it splits on the usual operators, honours quotes and
// drops heredoc bodies, so text that merely MENTIONS a command never matches.
// Subshells and `$(...)` are split out like any command (they run, after all);
// inside double quotes a substitution stays one word, which errs towards
// allowing. A `cd` inside a subshell is taken to last -- same direction.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const MAIN_CHECKOUT_FORBIDDEN = new Set([
  'commit',
  'push',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
]);
const PNPM_INSTALLING = new Set(['install', 'i', 'add']);
const PNPM_VALUE_OPTIONS = new Set(['-C', '--dir', '-F', '--filter', '--workspace-dir']);
const PREFIX_COMMANDS = new Set(['command', 'builtin', 'exec', 'nohup', 'time']);

/** Splits a command line into simple commands, each an array of words. */
export function splitCommands(line) {
  const commands = [];
  const heredocs = [];
  let words = [];
  let word = '';
  let inWord = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end < 0 ? line.length : end);
      inWord = true;
      i = end < 0 ? line.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) {
          word += line[j + 1];
          j += 2;
        } else {
          word += line[j];
          j += 1;
        }
      }
      inWord = true;
      i = j + 1;
    } else if (c === '\\') {
      if (line[i + 1] !== '\n') {
        word += line[i + 1] ?? '';
        inWord = true;
      }
      i += 2;
    } else if (c === '\n') {
      endCommand();
      i = skipHeredocBodies(line, i + 1, heredocs);
    } else if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
    } else if (c === '#' && !inWord) {
      const eol = line.indexOf('\n', i);
      i = eol < 0 ? line.length : eol;
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      if (line[j] === '-') j += 1;
      while (line[j] === ' ' || line[j] === '\t') j += 1;
      let delimiter = '';
      if (line[j] === "'" || line[j] === '"') {
        const end = line.indexOf(line[j], j + 1);
        delimiter = line.slice(j + 1, end < 0 ? line.length : end);
        j = end < 0 ? line.length : end + 1;
      } else {
        while (j < line.length && !/[\s;&|<>()]/.test(line[j])) delimiter += line[j++];
      }
      if (delimiter) heredocs.push(delimiter);
      i = j;
    } else if (c === '>' || c === '<') {
      endWord();
      i += line[i + 1] === '&' || line[i + 1] === c ? 2 : 1;
    } else if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
      endCommand();
      i += (c === '&' || c === '|') && line[i + 1] === c ? 2 : 1;
    } else {
      word += c;
      inWord = true;
      i += 1;
    }
  }
  endCommand();
  return commands;
}

// Heredoc bodies start on the line after their `<<DELIM` and end at a line
// that is exactly the delimiter (tabs stripped for `<<-`).
function skipHeredocBodies(line, i, heredocs) {
  while (heredocs.length > 0) {
    const delimiter = heredocs.shift();
    while (i < line.length) {
      const eol = line.indexOf('\n', i);
      const current = line.slice(i, eol < 0 ? line.length : eol);
      i = eol < 0 ? line.length : eol + 1;
      if (current.replace(/^\t+/, '') === delimiter) break;
    }
  }
  return i;
}

// `env -u X`, `VAR=1`, `command`, ... in front of the real program.
function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_COMMANDS.has(w)) {
      i += 1;
    } else if (w === 'env') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += words[i] === '-u' ? 2 : 1;
    } else {
      break;
    }
  }
  return words.slice(i);
}

/** Resolves a `cd`/`-C` target; null when it cannot be known statically. */
function resolveDir(base, target) {
  if (target === undefined || target === '~') return homedir();
  if (target.includes('$') || target.includes('`') || target === '-') return null;
  if (target.startsWith('~/')) return resolve(homedir(), target.slice(2));
  if (isAbsolute(target)) return resolve(target);
  return base === null ? null : resolve(base, target);
}

function gitDirs(dir) {
  if (dir === null) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    const [gitDir, commonDir] = out.trim().split('\n');
    return { gitDir: realpathSync(gitDir), commonDir: realpathSync(commonDir) };
  } catch {
    return null;
  }
}

function mainCheckoutOf(commonDir) {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

/** Returns the findings for one command line; empty means: let it run. */
export function findViolations(commandLine, cwd, projectDir) {
  const project = gitDirs(projectDir);
  const findings = [];
  let dir = cwd;

  for (const raw of splitCommands(commandLine)) {
    const words = stripPrefixes(raw);
    if (words.length === 0) continue;
    const program = basename(words[0]);

    if (program === 'cd') {
      dir = resolveDir(dir, words[1]);
      continue;
    }

    if (program === 'gh') {
      const isComment = words.includes('comment') && (words.includes('issue') || words.includes('pr'));
      if (isComment && words.some((w) => w === '--edit-last' || w.startsWith('--edit-last='))) {
        findings.push({ kind: 'edit-last' });
      }
      continue;
    }

    if (project === null) continue;

    if (program === 'git') {
      let target = dir;
      let i = 1;
      let known = true;
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-C') {
          target = resolveDir(target, words[i + 1]);
          i += 2;
        } else if (words[i] === '-c') {
          i += 2;
        } else if (words[i].startsWith('--git-dir') || words[i].startsWith('--work-tree')) {
          known = false;
          break;
        } else {
          i += 1;
        }
      }
      const sub = words[i];
      if (!known || !MAIN_CHECKOUT_FORBIDDEN.has(sub)) continue;
      const dirs = gitDirs(target);
      if (dirs && dirs.gitDir === dirs.commonDir && dirs.commonDir === project.commonDir) {
        findings.push({ kind: 'main-checkout', sub, path: mainCheckoutOf(dirs.commonDir) });
      }
      continue;
    }

    if (program === 'pnpm') {
      let sub;
      let hasDir = false;
      for (let i = 1; i < words.length; i += 1) {
        const w = words[i];
        if (w === '-C' || w === '--dir' || w.startsWith('--dir=')) hasDir = true;
        if (sub === undefined) {
          if (PNPM_VALUE_OPTIONS.has(w)) i += 1;
          else if (!w.startsWith('-')) sub = w;
        }
      }
      if (!PNPM_INSTALLING.has(sub) || hasDir) continue;
      const dirs = gitDirs(dir);
      if (dirs && dirs.gitDir !== dirs.commonDir && dirs.commonDir === project.commonDir) {
        findings.push({ kind: 'pnpm', sub, path: mainCheckoutOf(dirs.commonDir) });
      }
    }
  }
  return findings;
}

function message(finding) {
  switch (finding.kind) {
    case 'edit-last':
      return [
        '✗ Blockiert: `--edit-last` bearbeitet den neuesten Kommentar dieses Kontos — nach einer Antwort ist das die des Menschen.',
        '  Eigenen Kommentar über seine ID ersetzen:',
        "  gh api --paginate repos/{owner}/{repo}/issues/<nr>/comments --jq '.[] | select(.body | contains(\"<Marker>\")) | .id'",
        '  gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<datei>',
      ].join('\n');
    case 'main-checkout':
      return [
        `✗ Blockiert: \`git ${finding.sub}\` im Haupt-Checkout ${finding.path}.`,
        '  Dort wird nie committet, gepusht oder der Branch gewechselt — mehrere Läufe teilen sich diesen HEAD (docs/warum/worktree.md).',
        `  Eigener Worktree je Ticket: git -C ${finding.path} worktree add -b <branch> <absoluter-pfad> origin/main`,
      ].join('\n');
    case 'pnpm':
      return [
        `✗ Blockiert: \`pnpm ${finding.sub}\` aus einem Worktree schreibt die node_modules-Links des Haupt-Checkouts relativ zum Worktree; nach \`git worktree remove\` zeigen sie ins Leere (#606).`,
        `  Stattdessen: pnpm install --frozen-lockfile --dir ${finding.path}`,
      ].join('\n');
    default:
      return '';
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const command = input?.tool_input?.command;
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  if (typeof command !== 'string' || command === '') return 0;

  const findings = findViolations(command, cwd, process.env.CLAUDE_PROJECT_DIR || cwd);
  if (findings.length === 0) return 0;

  const seen = new Set();
  const text = findings
    .map(message)
    .filter((m) => m !== '' && !seen.has(m) && seen.add(m))
    .join('\n\n');
  process.stderr.write(`${text}\n`);
  return 2;
}

try {
  process.exitCode = main();
} catch {
  process.exitCode = 0;
}
