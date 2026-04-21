#!/usr/bin/env bash
set -euo pipefail

common_git_dir="$(git rev-parse --git-common-dir)"
hooks_dir="${common_git_dir}/hooks"
target_hook="${hooks_dir}/pre-push"
managed_marker="agent-smith-managed-pre-push"

mkdir -p "$hooks_dir"

if [[ -e "$target_hook" ]] && ! grep -Fq "$managed_marker" "$target_hook"; then
	echo "Refusing to overwrite existing pre-push hook: $target_hook" >&2
	echo "Move it aside or merge it with .githooks/pre-push manually." >&2
	exit 1
fi

tmp_hook="$(mktemp)"
cat >"$tmp_hook" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# agent-smith-managed-pre-push

repo_root="$(git rev-parse --show-toplevel)"
delegate_hook="${repo_root}/.githooks/pre-push"

if [[ ! -x "$delegate_hook" ]]; then
	echo "agent-smith: missing executable hook at $delegate_hook" >&2
	exit 1
fi

exec "$delegate_hook" "$@"
EOF

mv "$tmp_hook" "$target_hook"
chmod +x "$target_hook"

echo "Installed managed pre-push hook at $target_hook"
echo "The dispatcher resolves .githooks/pre-push from the current worktree."
