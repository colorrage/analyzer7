---
name: analyzer-recipe
description: Lists, shows, runs, and manages Analyzer7 recipes — markdown playbooks that orchestrate existing Analyzer7 commands (seo-audit, seo-weekly, experiment-analysis, growth-baseline, revenue-audit, tracking-audit, monthly-business-review, ranking-monitor, content-decay, conversion-funnel). Built-in recipes ship with the skill; project recipes in `.analyzer/recipes/` override them by name. Use when the user asks to run, list, show, create, or change an Analyzer7 recipe or playbook. Keywords: analyzer, recipe, playbook, runbook, seo-audit, seo-weekly, experiment-analysis, growth-baseline, monthly review.
---

# analyzer-recipe

A recipe orchestrates existing capabilities. It holds no hidden business logic: every number comes from the scripts, and every rule comes from the Analyzer7 references.

## Where recipes live

- Built-in: `recipes/<name>.md` in this skill folder.
- Project: `.analyzer/recipes/<name>.md`. A project recipe with the same name overrides the built-in one.

Shape (the Hyper7 recipe shape): frontmatter `name` (kebab-case, equal to the file stem) and `description`, then numbered steps.

## Operations

| Intent | Operation |
| --- | --- |
| list recipes | List project and built-in recipes, one line each, marking overrides. |
| show a recipe | Display it without running it. |
| run a recipe | Probe state first (`../analyzer/scripts/state.mjs`), then follow the steps in order. Each step names the skill or command to use. Stop and ask when a step needs data that is not ingested, a metric that is not confirmed, or any action outside `.analyzer/`. |
| create or update a recipe | Write `.analyzer/recipes/<name>.md` from the user's steps. Never overwrite silently; never edit built-in recipes from a project. |
| delete a recipe | Remove only the project file. |

When running, report progress plainly and end with the artifacts written (reports, EV/BL/AN/SEO-OPP IDs) and the next analytical action from the probe.
