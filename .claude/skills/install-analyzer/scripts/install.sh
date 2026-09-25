#!/usr/bin/env bash
# Install, inspect, or remove Analyzer7 skill symlinks. Links point to this
# checkout so local changes take effect without copying or reinstalling.

set -euo pipefail

action="${1:-install}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/../../../../skills" && pwd)"

if [ ! -d "$source_dir" ]; then
  echo "error: source skills directory not found at $source_dir" >&2
  echo "hint: run this script from a Analyzer7 repository checkout" >&2
  exit 1
fi

default_targets=(
  "$HOME/.claude/skills"
  "$HOME/.codex/skills"
  "$HOME/.agents/skills"
  "$HOME/.pi/agent/skills"
)

if [ -n "${ANALYZER_INSTALL_TARGETS:-}" ]; then
  IFS=':' read -r -a targets <<<"$ANALYZER_INSTALL_TARGETS"
  for target in "${targets[@]}"; do
    case "$target" in
      /*) ;;
      *)
        echo "error: ANALYZER_INSTALL_TARGETS entries must be absolute paths: $target" >&2
        exit 1
        ;;
    esac
  done
else
  targets=()
  for target in "${default_targets[@]}"; do
    if [ -d "$(dirname "$target")" ]; then
      targets+=("$target")
    fi
  done
fi

if [ "${#targets[@]}" -eq 0 ]; then
  echo "error: no install targets found" >&2
  echo "hint: none of the supported agent directory parents exist" >&2
  exit 1
fi

skills=()
while IFS= read -r skill_dir; do
  skills+=("$(basename "$skill_dir")")
done < <(
  find "$source_dir" -mindepth 1 -maxdepth 1 -type d \
    -exec test -f '{}/SKILL.md' ';' -print | LC_ALL=C sort
)

if [ "${#skills[@]}" -eq 0 ]; then
  echo "error: no skills found under $source_dir" >&2
  exit 1
fi

install_one() {
  local target="$1"
  mkdir -p "$target"
  echo "-> $target"

  for skill in "${skills[@]}"; do
    local source="$source_dir/$skill"
    local destination="$target/$skill"

    if [ -L "$destination" ]; then
      local current
      current="$(readlink "$destination")"
      if [ "$current" = "$source" ]; then
        echo "    ok     $skill (already linked)"
      else
        echo "    skip   $skill (link points elsewhere: $current)"
      fi
    elif [ -e "$destination" ]; then
      echo "    skip   $skill (exists and is not a symlink)"
    else
      ln -s "$source" "$destination"
      echo "    link   $skill"
    fi
  done
}

uninstall_one() {
  local target="$1"
  echo "<- $target"

  if [ ! -d "$target" ]; then
    echo "    skip   (target does not exist)"
    return
  fi

  for skill in "${skills[@]}"; do
    local source="$source_dir/$skill"
    local destination="$target/$skill"

    if [ -L "$destination" ]; then
      local current
      current="$(readlink "$destination")"
      if [ "$current" = "$source" ]; then
        rm "$destination"
        echo "    unlink $skill"
      else
        echo "    skip   $skill (link points elsewhere: $current)"
      fi
    elif [ -e "$destination" ]; then
      echo "    skip   $skill (exists and is not a symlink)"
    fi
  done
}

status_one() {
  local target="$1"
  echo "@ $target"

  if [ ! -d "$target" ]; then
    echo "    (target does not exist)"
    return
  fi

  for skill in "${skills[@]}"; do
    local source="$source_dir/$skill"
    local destination="$target/$skill"

    if [ -L "$destination" ]; then
      local current
      current="$(readlink "$destination")"
      if [ "$current" = "$source" ]; then
        printf "    %-24s linked (this repo)\n" "$skill"
      else
        printf "    %-24s linked to %s\n" "$skill" "$current"
      fi
    elif [ -e "$destination" ]; then
      printf "    %-24s exists (not a symlink)\n" "$skill"
    else
      printf "    %-24s not installed\n" "$skill"
    fi
  done
}

case "$action" in
  install)
    echo "source: $source_dir"
    for target in "${targets[@]}"; do install_one "$target"; done
    ;;
  uninstall)
    echo "source: $source_dir"
    for target in "${targets[@]}"; do uninstall_one "$target"; done
    ;;
  status)
    echo "source: $source_dir"
    for target in "${targets[@]}"; do status_one "$target"; done
    ;;
  *)
    echo "usage: $(basename "$0") [install|uninstall|status]" >&2
    exit 1
    ;;
esac
