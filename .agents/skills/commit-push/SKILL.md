---
name: commit-push
description: Use when the user explicitly asks to commit and push Git changes, including `$commit-push` or a request written as `/commit-push`. Review the requested changes, create one normal commit, and push it safely; do not use for commit-only or push-only requests.
---

# Commit and push

This skill is for an explicit commit-and-push request. Installing or discussing the skill does not authorize a commit or push. If the request includes arguments, treat them as the scope or a hint about the intended files; otherwise consider all current changes. Follow repository instructions and preserve the user's existing work.

1. Inspect `git status` (including untracked files, without `-uall`), `git diff`, `git diff --staged`, and `git log --oneline -10`. Identify the current branch, remote, upstream, and exact files in scope. Read untracked files that may be included. If there is nothing to commit, report that and stop; never create an empty commit. If staged changes outside the requested scope exist, stop for a decision instead of silently committing or unstaging them.
2. Run `git fetch` and compare the branch with the freshly fetched upstream. Do not rely on a pre-fetch “up to date” status. If fetch fails or the branches have diverged, report the state and stop. Do not automatically merge, rebase, reset, clean, or stash.
3. Review the exact content to be committed for secrets and unintended files: `.env`, credentials, private keys, certificates, API tokens, local configuration, and generated output. If anything suspicious is present, do not stage or commit it; report the concern without exposing the value and ask how to proceed.
4. Stage only the intended paths with `git add -- <path>`; never use `git add -A` or `git add .`. Check `git status` and `git diff --cached` again. If the staged result contains unrelated content, stop and resolve the scope before committing.
5. Draft a concise message that emphasizes why the change was made and matches the repository's recent language and style. Create a new commit, not an amend, unless the user separately requests amendment. On Windows, use a UTF-8 message file with `git commit -F` when multiline text or quoting requires it. Do not change Git configuration, bypass hooks with `--no-verify`, or disable signing with `--no-gpg-sign`. If a hook fails, fix only issues within the authorized scope, recheck the staged diff, and retry; otherwise report the failure and stop. Do not copy Claude's co-author trailer or invent a Codex email address.
6. Before pushing, confirm the branch still has a safe fast-forward relationship with the fetched upstream. Never force push or use `--force-with-lease` without a separate explicit request. For a branch without upstream, confirm `origin` is the intended remote, then use `git push -u origin <branch>`; otherwise use `git push`. If the push is rejected, report it and stop without an automatic merge or rebase.
7. Verify the commit hash, message, destination branch, push result, and final `git status`. Report remaining changes and any check that could not be completed. Never claim a push succeeded without checking its result.

Codex invokes this skill explicitly as `$commit-push`. A slash-form request is ordinary text and should be interpreted as a request for this workflow when the skill is available.
