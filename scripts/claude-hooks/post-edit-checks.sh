#!/usr/bin/env bash
# PostToolUse hook for Claude Code (issue #1208), wired in .claude/settings.json.
#
# Runs the CI guards (scripts/check-*.sh) that apply to the file Claude just
# edited, and reports only findings that name that file. Exit 2 puts stderr in
# front of the model, so a violation surfaces at edit time instead of one CI
# round later. Every other outcome is exit 0: the hook never stops a run.
#
# No rules of its own: whatever it reports, CI would fail on anyway.
#
# The guards run in the repo of the EDITED FILE, with that repo's scripts --
# not in $CLAUDE_PROJECT_DIR. A chat session lives in the main checkout but
# builds in ~/dev/starship-worktrees/<slug>; the worktree is what CI will see.
set -uo pipefail

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

file=$(printf '%s' "$input" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const p = JSON.parse(s)?.tool_input?.file_path;
      if (typeof p === "string") process.stdout.write(p);
    } catch {}
  });
' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0

case "$file" in
  /*) ;;
  *) file="${CLAUDE_PROJECT_DIR:-$PWD}/$file" ;;
esac

# Physical paths on both sides: git reports the resolved toplevel, while the
# tool may hand over a symlinked spelling (/tmp vs /private/tmp on macOS).
dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P) || exit 0
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
root=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
abs="$dir/$(basename "$file")"
rel="${abs#"$root"/}"
[ "$rel" != "$abs" ] || exit 0

# Which guards look at this path. Each entry is "<script>|<mode>": "path"
# reports the guard's lines that name the file; any other mode is a regex,
# and every red block whose summary line matches it is reported whole -- for
# guards whose findings don't name a file (code map sizes, schema tables).
checks=()
case "$rel" in
  *.spec.ts | *.test.ts) checks+=("check-test-integrity.sh|path") ;;
esac
case "$rel" in
  src/*.css) checks+=("check-design-tokens.sh|path") ;;
  src/db/schema.ts) checks+=("check-sync-invariants.sh|path" "check-tenant-isolation.sh|path" "check-tenant-isolation.sh|tenantPrimaryKey") ;;
  src/*.ts | src/*.tsx) checks+=("check-sync-invariants.sh|path" "check-tenant-isolation.sh|path") ;;
  docs/CODEMAP.md | docs/codemap/*.md) checks+=("check-codemap.sh|.") ;;
esac
[ "${#checks[@]}" -gt 0 ] || exit 0

esc=$(printf '\033')
report=""
for entry in "${checks[@]}"; do
  script="${entry%%|*}"
  mode="${entry#*|}"
  [ -f "$root/scripts/$script" ] || continue

  out=$(cd "$root" && bash "scripts/$script" 2>&1) && continue
  out=$(printf '%s\n' "$out" | sed "s/${esc}\[[0-9;]*m//g")

  if [ "$mode" = "path" ]; then
    hits=$(printf '%s\n' "$out" | awk -v p="$rel" '{
      s = $0; sub(/^[[:space:]]+/, "", s)
      if (index(s, p) == 1) { c = substr(s, length(p) + 1, 1); if (c == "" || c == ":") print $0 }
    }')
  else
    # A block is the lines before a summary line (✓/✗). Hints printed after a
    # ✗ land in the next block and are dropped with it -- the ✗ line says enough.
    hits=$(printf '%s\n' "$out" | awk -v re="$mode" '
      /^✓/ { buf = ""; next }
      /^✗/ { if ($0 ~ re) printf "%s%s\n", buf, $0; buf = ""; next }
      { buf = buf $0 "\n" }
    ')
  fi
  [ -n "$hits" ] || continue

  report="${report}✗ scripts/$script würde in CI rot — Befund in $rel:
$hits
  Vollständig: (cd $root && bash scripts/$script)

"
done

[ -n "$report" ] || exit 0
printf '%s' "$report" >&2
exit 2
