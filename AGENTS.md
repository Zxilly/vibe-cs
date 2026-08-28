# Project Agent Instructions

## Release Status

**Status: UNRELEASED**

- Only a human maintainer may change this status to `RELEASED`.
- Until the status above is changed to `RELEASED`, breaking and destructive product changes are allowed when they simplify the current design.
- Do not preserve backward or forward compatibility for pre-release database schemas, persisted JSON documents, routes, IPC commands, generated TypeScript bindings, configuration shapes, local-storage documents, or legacy Project data.
- Prefer replacing the old model and deleting obsolete code, tables, migrations, adapters, feature flags, and compatibility tests over carrying both designs.
- Pre-release managed app data may be reset or recreated when required by the new schema. This does not authorize deleting source Demo files, source media, exported user files, or unrelated data outside Vibe CS managed app-data locations.
- For the unified Editing Document rewrite, do not implement legacy database detection, migration, import, or reset UI. The development database is manually removed before the new startup is exercised; startup may assume the database does not exist and create only the current schema.
- Complete the unified Editing Document rewrite across the existing product: consolidate all current Agent, Quick, and Multitrack editing actions, and rewrite recording and export to consume the same Project Head and Timeline Clip identities. Delete the replaced Plan/Montage/Editor write models and copy paths.
- Keep one production Project Timeline Module over the canonical Editing Document. It must render real Timeline Tracks and Timeline Placement through `domain/editing/ProjectTimeline`, use `design/timeline` as the only time geometry, and use `design/review` plus `theme.css` as the visual Interface. Do not add page-private timeline geometry, hidden accessibility-only tracks, or workbench-specific stylesheets.
- Keep exactly one implementation path. Do not add legacy adapters, compatibility wrappers, translators, aliases, deprecated routes, dual-read/dual-write logic, or old-to-new conversion code. Rewrite each caller to the unified model and delete the old types, tables, routes, hooks, pages, tests, and generated bindings as soon as that capability moves.
- Temporary coexistence is allowed only inside one actively edited, uncommitted change needed to keep the rewrite mechanically manageable. Do not commit or leave a working state with two product implementations for the same capability.
- Do not introduce a generic workflow engine, event-sourcing framework, multiplayer collaboration protocol, plugin system, speculative adapter hierarchy, or compatibility facade. Add depth only at seams with two real callers or adapters in the current product.
- Avoid meaningless defensive programming. Validate untrusted input and external side effects at their seams, but rely on internal types, constructors, and established invariants instead of repeating impossible-state checks throughout the implementation.
- Once the status is changed to `RELEASED`, treat persisted and public contracts as compatibility-sensitive from that commit forward; do not infer compatibility requirements retroactively.

## Git Commit Style

- Before every `git commit`, inspect the repository's recent commit messages (for example, `git log --oneline -20`) and match the dominant existing style.
- Prefer the repository's local convention over a generic default. If multiple styles are present, use the most recent consistent style or ask before committing when the intended style is unclear.
