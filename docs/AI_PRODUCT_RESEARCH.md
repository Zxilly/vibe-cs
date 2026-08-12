# AI collaboration product research

Research date: 2026-08-12. Audience: CS2 demo reviewers and video creators who understand a match
but may not know HLAE or professional editing terminology. Scope: conversational demo guidance,
AI-assisted rough cuts, cinematic camera planning, and music-driven timing in a local desktop app.

## Executive read

The strongest pattern is an assistant embedded beside the work, not a separate chatbot that loses
the selected demo, timeline, and undo state. Descript exposes its co-editor from the editing surface;
Premiere lets natural-language search return concrete footage that can be inspected before use.
Resolve and CapCut make detected beats visible on the timeline, but public CapCut reports show that
users lose trust when preview and export timing drift or when beat markers cannot be corrected.
For Vibe CS, the agent should therefore produce evidence-linked, revision-bound proposals and let
the user apply them as one undoable operation. HLAE adds a second trust boundary: rich cameras are
valuable, but generated commands must be offline-only, typed, previewable, and explicit about
`-insecure`. External reference research remains a maintainer activity during development; the
product Agent uses only bounded local evidence and proposal tools.

## Ranked product problems

### 1. A useful answer must understand the selected match and edit

- User goal: ask “why did this round fail?” or “make a 30-second clutch montage” without manually
  restating player IDs, round numbers, clips, and project constraints.
- Evidence: Descript positions its assistant as an in-editor co-editor with access to editing tools;
  Premiere search turns plain-language queries into inspectable media results and in/out points.
- Product move: scope each thread to explicit demos/project/music, show those attachments above the
  composer, and expose every retrieved evidence ID in the response.
- Severity: high. Frequency signal: high across the reference products. Confidence: high.

### 2. Users need control over AI edits, not an opaque “magic” mutation

- User goal: get a useful first draft while keeping authorship and undo safety.
- Evidence: professional editors keep a visible timeline even when adding AI search or assistance.
  This is an inference from product structure rather than a direct complaint count.
- Product move: tools return proposal cards with a diff, base revision, confidence, unsupported
  operations, and Apply/Revise/Reject. No model tool writes the project directly.
- Severity: high. Frequency signal: structural. Confidence: high.

### 3. Beat detection is only useful when timing remains explainable and stable

- User goal: cut kills, transitions, and camera accents to meaningful musical beats.
- Evidence: Resolve displays detected music beats and supports snapping. CapCut offers Beat Sync,
  while recent public reports describe markers or exports drifting and effects still requiring
  manual synchronization. These reports are anecdotal, not prevalence estimates.
- Product move: decode locally, expose beat/downbeat/energy confidence, draw editable markers, and
  generate a deterministic alignment proposal. The render uses the same measured timestamps as the
  preview and integration tests verify muxed duration.
- Severity: high. Frequency signal: medium. Confidence: medium-high.

### 4. HLAE power is difficult to discover and easy to use unsafely

- User goal: create campaths, FOV moves, POV locks, and clean streams without learning every
  `mirv_*` command.
- Evidence: AdvancedFX documents a broad CS2 command surface; its command help is hierarchical and
  several script commands remain experimental. Official launch guidance requires offline/insecure
  use. Open issues continue to request output-naming quality-of-life improvements.
- Product move: offer named shot recipes and a 3D/timeline preview compiled into an allowlisted
  typed plan. Show exact generated config, validation, installation/version state, and the offline
  safety warning before export or launch.
- Severity: high. Frequency signal: medium. Confidence: high for complexity, low for population size.

### 5. Provider setup can easily become misleading

- User goal: configure an AI provider in the product, then know which capabilities are actually
  available and what they cost.
- Evidence: Kimi documents that Kimi Code and Kimi Open Platform credentials/endpoints are not
  interchangeable. The production implementation uses Rig inside Tauri and adapts its stream to
  the application-owned React thread protocol.
- Product move: display model chat and local tool calling as separate capability checks. Product
  credentials are configured only in Vibe CS Settings; development overrides remain debug-only
  process environment values. The product Agent does not expose a general network tool.
- Severity: medium-high. Frequency signal: medium. Confidence: high.

## Opportunity map

## Counter-Strike-specific tool audit

The implementation was checked against the current open-source CS Demo Manager checkout
(`akiver/cs-demo-manager`, commit `8961f50`), the local CS2 Insight Agent checkout
(`02920eb`), Freezetime (`dcf6a20`), and Breakdown's published Tactical Analyst surface.
CS Demo Manager is not itself an LLM agent; its value as a reference is the verified data surface
an agent should be able to query: match overview/scoreboard, rounds, players, weapons, duels,
opening duels, grenades, economy, heatmaps, 2D replay, video timeline, and chat records. Breakdown
publishes the closest explicit agent-tool vocabulary: Search Rounds, Round Context, Round Events,
Events Batch, and Full Demo Data. CS2 Insight Agent adds bounded highlight/fail classification and
director planning, while Freezetime is a useful counterexample that keeps deterministic local
analysis separate from external LLMs.

Vibe CS mirrors those useful seams with narrower, evidence-bound tools rather than one oversized
"full database" tool:

| Reference surface | Vibe CS tool | Product boundary |
| --- | --- | --- |
| Match overview, scoreboard, rounds, players | `read_demo_evidence` | persisted local analysis only |
| Search Rounds | `search_rounds` | bounded filters for side, player, purchase, round, event |
| Round Context | `read_round_context` | explicit round numbers; economy and state included |
| Round Events / Events Batch | `read_round_events` | bounded event kinds, players, and result count |
| Duels and opponent tendencies | `read_player_matchups` | deterministic player-v-player aggregates |
| Highlight/fail collections | `read_highlights` | stable evidence IDs and tick ranges |
| Match video timeline | `read_editor_timeline` | selected project and optimistic revision |
| Music timing | `read_audio_analysis`, `draft_beat_alignment` | native decoded evidence; proposal only |
| Director/cinematic planning | `draft_edit_plan`, `draft_hlae_plan` | typed proposal; no direct mutation or launch |

The product intentionally does not expose filesystem, shell, SQL, arbitrary HTTP, raw console, or
generic web-search tools. Mutations happen only after a second Rust-side preview, exact diff,
fingerprint/revision validation, and explicit user confirmation.

### Deliver first

- Context attachments for demos, player, project, and music.
- Read-only evidence tools plus proposal-only edit/HLAE/audio tools.
- Streaming tool states, cited evidence, cancellation, cost and capability status.
- Revision-safe proposal confirmation and one-step undo.
- Visible beat grid with confidence and deterministic snapping.

### Follow with deeper workflows

- Saved shot recipes and reusable creative briefs.
- Side-by-side visual review over locally generated or replayed camera candidates.
- Side-by-side candidate edits and A/B preview.
- Per-map camera collision and occlusion scoring where trustworthy geometry exists.
- Agent eval fixtures for factual grounding, invalid tool calls, stale revisions, and unsafe HLAE
  requests.

### Needs deeper research

- Whether users prefer one persistent project thread or short task threads.
- How much HLAE command detail beginners want visible by default.
- Genre-specific beat/downbeat quality and acceptable manual correction time.
- Cost expectations for Kimi K3 reasoning.

## Source map

- AdvancedFX command reference and issues: command breadth, experimental scripts, CS2 surface, and
  output workflow requests.
- CS Demo Manager source: <https://github.com/akiver/cs-demo-manager> — the Counter-Strike match,
  round, player, duel, grenade, economy, replay, video, and chat data surfaces an assistant must
  query without inventing facts.
- Breakdown Tactical Analyst: <https://www.breakdown.gg/> — the published Search Rounds, Round
  Context, Round Events, Events Batch, and Full Demo Data agent-tool vocabulary.
- CS2 Insight Agent source: <https://github.com/DrEAmSs59/CS2-insight-agent> — deterministic
  highlight/fail classification, recording director, and bounded AI commentary separation.
- Freezetime source: <https://github.com/benginN/csfreezetime> — local deterministic opponent,
  utility, replay, and strategy analysis without an external LLM dependency.
- Rig documentation: in-process streaming, typed/dynamic tools, and OpenAI-compatible providers.
- Kimi documentation: provider separation, model IDs, endpoints, credential storage, and tool calls.
- Descript help/changelog: contextual co-editor placement and history.
- Adobe Premiere help: local media analysis, natural-language search, filters, and inspectable
  results.
- Blackmagic Resolve feature guide: detected beat markers and timeline snapping.
- CapCut help plus recent Reddit reports: automatic beat-sync goal and anecdotal timing/control
  failures.

Public signal is strongest for documented product behavior and weaker for population-level user
frequency; recommendations based on anecdotes are marked accordingly.
