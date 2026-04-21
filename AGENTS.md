# Agent Smith Repo Instructions

- Before pushing or updating a PR, run `rtk make pre-push` from the repo root and fix every failure locally.
- If you want pushes blocked automatically, run `rtk make install-git-hooks` once for this clone. The installed hook dispatches to the current worktree's tracked `.githooks/pre-push`.
- Do not push with failing local validation.
