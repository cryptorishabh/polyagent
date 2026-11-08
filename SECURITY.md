# Security

## Model

polyagent runs third-party agent CLIs that execute model-generated code on your machine. It reduces risk; it does not remove it.

What polyagent enforces:
- **Isolation by worktree.** Each attempt runs in a fresh git worktree under `.polyagent/wt/` on its own branch. Your checked-out branch is touched only by `polyagent merge`, which you run.
- **Vendor sandboxes on.** Codex `-s workspace-write`, agy `--sandbox --mode accept-edits`, Gemini `--approval-mode auto_edit`. polyagent never passes "bypass"/"yolo" flags.
- **Recursion lock.** Workers get `POLYAGENT_DEPTH` and a PATH shim that turns `codex`, `agy`, `gemini`, `claude`, `polyagent` and other agent CLIs into stubs that exit with code 97. polyagent refuses to start when `POLYAGENT_DEPTH >= 1`.
- **Bounded runs.** Wall-clock timeout with process-tree kill, at most 3 attempts per task, per-provider budgets.
- **Verification by command.** Tests run by polyagent decide pass/fail, not a model's claim.

Known limits:
- The PATH shim doesn't stop a worker that calls an agent by **absolute path**, or a network API directly. Vendor sandboxes may or may not block those.
- Sandboxing differs by vendor and OS. On Windows, check that each CLI's own sandbox is set up (`codex sandbox`, etc.).
- The `test` and `setup` commands from your tasks file run in your shell with your permissions.
- Worker output is untrusted. Review diffs before merging, especially anything flagged `outOfScope` or tagged with a risk.

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories on this repository, not in public issues.
