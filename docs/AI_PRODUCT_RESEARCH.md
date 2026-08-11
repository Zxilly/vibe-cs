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
`-insecure`. Network research is useful for inspiration, but it should be visibly sourced and
separate from facts extracted from the user's demo.

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

### 5. Provider and search setup can easily become misleading

- User goal: import an existing development credential, then know which capabilities are actually
  available and what they cost.
- Evidence: Kimi documents that Kimi Code and Kimi Open Platform credentials/endpoints are not
  interchangeable. Kimi official web search is a separately billed tool and is currently described
  as undergoing updates. assistant-ui's Mastra integration also requires an application-owned
  runtime rather than providing a turnkey Mastra adapter.
- Product move: display model chat, tool calling, and web research as separate capability checks.
  Import only the selected OpenCode credential after confirmation, never reveal it, and do not mark
  web research ready without a compatible configured provider.
- Severity: medium-high. Frequency signal: medium. Confidence: high.

## Opportunity map

### Deliver first

- Context attachments for demos, player, project, and music.
- Read-only evidence tools plus proposal-only edit/HLAE/audio tools.
- Streaming tool states, cited evidence, cancellation, cost and capability status.
- Revision-safe proposal confirmation and one-step undo.
- Visible beat grid with confidence and deterministic snapping.

### Follow with deeper workflows

- Saved shot recipes and reusable creative briefs.
- Visual media search over generated/replayed camera candidates.
- Side-by-side candidate edits and A/B preview.
- Per-map camera collision and occlusion scoring where trustworthy geometry exists.
- Agent eval fixtures for factual grounding, invalid tool calls, stale revisions, and unsafe HLAE
  requests.

### Needs deeper research

- Whether users prefer one persistent project thread or short task threads.
- How much HLAE command detail beginners want visible by default.
- Genre-specific beat/downbeat quality and acceptable manual correction time.
- Cost expectations for Kimi K3 reasoning and paid web search.

## Source map

- AdvancedFX command reference and issues: command breadth, experimental scripts, CS2 surface, and
  output workflow requests.
- assistant-ui Mastra guide and Mastra docs: sidecar/server runtime, streaming, tools, and memory
  requirements.
- Kimi and OpenCode documentation: provider separation, model IDs, endpoints, credential storage,
  tool calls, and web-search billing/status.
- Descript help/changelog: contextual co-editor placement and history.
- Adobe Premiere help: local media analysis, natural-language search, filters, and inspectable
  results.
- Blackmagic Resolve feature guide: detected beat markers and timeline snapping.
- CapCut help plus recent Reddit reports: automatic beat-sync goal and anecdotal timing/control
  failures.

Public signal is strongest for documented product behavior and weaker for population-level user
frequency; recommendations based on anecdotes are marked accordingly.
