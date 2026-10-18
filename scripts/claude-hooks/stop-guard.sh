#!/usr/bin/env bash
# Stop hook for Claude Code (issue #1214), wired in .claude/settings.json.
#
# A build run in a ticket worktree does not end while its work exists only
# locally: #830 had the fix done and the fast gates green, and still ended
# without a single commit. Exit 2 keeps the run going with the message below.
#
# One nudge, no loop: when Claude Code reports stop_hook_active, the run has
# already been held back once and may end. Silent (exit 0) in the main
# checkout (chat sessions), on a detached HEAD (read-only roles), on any
# branch that is not feat|fix|chore/<nr>-..., and on any error.
set -uo pipefail

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

parsed=$(printf '%s' "$input" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s);
      if (typeof j.cwd === "string") process.stdout.write(`${j.stop_hook_active === true}\n${j.cwd}`);
    } catch {}
  });
' 2>/dev/null) || exit 0
[ -n "$parsed" ] || exit 0
active="${parsed%%$'\n'*}"
cwd="${parsed#*$'\n'}"

[ "$active" = "false" ] || exit 0
[ -d "$cwd" ] || exit 0

git_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$git_dir" != "$common_dir" ] || exit 0

branch=$(git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null) || exit 0
[[ "$branch" =~ ^(feat|fix|chore)/[0-9]+- ]] || exit 0

dirty=$(git -C "$cwd" status --porcelain 2>/dev/null) || exit 0

# Commits that are on no remote-tracking ref yet. The remote branch of the
# same name comes first: a branch cut from origin/main gets origin/main as its
# upstream (branch.autoSetupMerge), and after a push without -u, @{u} would
# still report every commit as unpushed. Then the upstream, then origin/main.
if git -C "$cwd" rev-parse --verify -q "refs/remotes/origin/$branch" >/dev/null; then
  base="origin/$branch"
elif upstream=$(git -C "$cwd" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  base="$upstream"
elif git -C "$cwd" rev-parse --verify -q refs/remotes/origin/main >/dev/null; then
  base="origin/main"
else
  base=""
fi
unpushed=0
[ -z "$base" ] || unpushed=$(git -C "$cwd" rev-list --count "$base..HEAD" 2>/dev/null) || unpushed=0

[ -n "$dirty" ] || [ "$unpushed" -gt 0 ] || exit 0

{
  echo "✗ Noch nicht gesichert — $branch liegt nicht vollständig auf dem Remote (CLAUDE.md, „Nach jedem Schritt\"; #830):"
  if [ -n "$dirty" ]; then
    echo "  - $(printf '%s\n' "$dirty" | wc -l | tr -d ' ') uncommittete Änderung(en):"
    printf '%s\n' "$dirty" | head -10 | sed 's/^/      /'
  fi
  if [ "$unpushed" -gt 0 ]; then
    echo "  - $unpushed Commit(s) nicht gepusht (Vergleich mit $base)"
  fi
  echo "  Committen und pushen, dann beenden. Geht das bewusst nicht, schreib den Grund in den Fortschrittskommentar."
} >&2
exit 2
