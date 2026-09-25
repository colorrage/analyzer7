---
name: install-analyzer
description: >
  Install, refresh, uninstall, or inspect local Analyzer7 skills by symlinking
  this repository's skill folders into supported agent skill directories.
---

# install-analyzer

Use this repository-local helper when a developer wants to install Analyzer7
skills from this checkout.

## Commands

```bash
bash .claude/skills/install-analyzer/scripts/install.sh install
bash .claude/skills/install-analyzer/scripts/install.sh status
bash .claude/skills/install-analyzer/scripts/install.sh uninstall
```

`install` is also the refresh action: the installed entries are symlinks, so
skill edits in this checkout are available immediately.

By default the script installs into each configured agent directory whose
parent exists. To use explicit isolated targets, set
`ANALYZER_INSTALL_TARGETS` to a colon-separated list of absolute directories:

```bash
ANALYZER_INSTALL_TARGETS=/path/one:/path/two \
  bash .claude/skills/install-analyzer/scripts/install.sh install
```

The script discovers folders containing `SKILL.md` under `skills/`. It never
replaces an existing file, directory, or link to another location, and its
uninstall action removes only symlinks that point to this checkout.

Analyzer7 skills are a suite: install them together. Sub-skills call scripts in
the sibling `analyzer` skill folder (`<skill-base-dir>/../analyzer/scripts/`).
