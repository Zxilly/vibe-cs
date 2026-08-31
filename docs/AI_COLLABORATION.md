# Agent and human collaboration

Vibe CS has one editing product model: a revisioned `Project` whose
`EditingDocument` owns every track and clip. Quick and Multitrack are UI lenses
over that document. The Agent is a panel in the same workspace, not a separate
plan, montage, editor, or conversion pipeline.

## Editing contract

- Human controls and Agent tools both commit `ProjectPatch` values and produce
  linear, undoable Change Groups.
- Human controls expose small timeline actions. The Agent additionally has the
  high-level `replace_story_timeline` operation, which stages and validates a
  complete Story Track before one atomic commit.
- An Agent turn acquires the exclusive Project Edit Lease. While it is held,
  the human may inspect and switch lenses, but every human editing control is
  read-only. The user can stop the Agent turn.
- The Agent may directly apply reversible edits. Each completed tool call and
  Change Group is shown in the panel; no separate proposal document exists.
- The Agent panel is one chronological conversation stream. Human messages,
  Agent text, live and completed tool calls, Edit Lease state, inline HITL
  requests, and final delivery actions stay in that stream rather than opening
  separate workflow or review pages.
- Every tool invocation receives one request-scoped stable ID before execution.
  The Channel projects `started` and exactly one terminal state (`completed`,
  `failed`, or `awaiting_confirmation`) under that identity. Terminal calls are
  persisted in the assistant turn; the live projection is handed to that
  durable turn before a background refetch, so the UI never flashes a stale
  “running” card after completion.
- HITL decisions are structured conversation entries bound to the originating
  `tool_call_id`. Unrelated human text cannot approve, reject, or dismiss a
  pending recording/export request, and reload preserves the decision link.
- Video playback and the tactical diagram share one docked left/right preview
  region. Their divider changes the width ratio; neither side is a floating
  window or a separate editing surface.
- Recording and final export are external executions. They always require an
  explicit human confirmation, including when Agent Auto mode is enabled.
- Capture Intent and Timeline Placement are separate. Placement-only edits keep
  a Take compatible; changing capture-producing fields makes it stale.
- Final export is fail-closed until every enabled clip has compatible media.
  Draft preview may show planned-media placeholders.

## Current Agent tools

- `read_workspace`: reads live Project context with progressive disclosure.
  Its default `summary` response carries the exact revision, workspace lens,
  selection, track/clip inventory and bounded material counts. An edit must use
  `detail=timeline` with the narrowest known `trackIds` or `clipIds`; omitting
  selectors is reserved for a deliberate whole-Project operation. A second
  read in the same Agent turn sees the Head produced by an earlier edit tool
  rather than the request-start checkpoint.
- `read_demo_evidence`: queries authoritative persisted Demo analysis referenced
  by the Project. Player work supplies `playerName` or `playerId` and may narrow
  `demoIds` and event `kinds`; the host filters raw per-Demo highlights before a
  1–128 result cap. Multi-Demo prompt context contains only an inventory, never
  a pre-truncated evidence dump.
- `read_cinematic_context`: reads producer-bound selected-round spatial evidence,
  round bounds, and camera feasibility for explicit highlight IDs.
- `read_project_delivery`: reads the authoritative Delivery Gate and latest
  Project export. A completed export includes its source Project revision,
  managed-file availability, size, probed duration, resolution, frame rate,
  and codecs. `matchesCurrentRevision` prevents an older MP4 from being
  presented as the current Head's delivery.
- `apply_project_patch`: applies one small revision-bound Project edit.
- `replace_story_timeline`: performs one Agent-only whole-story replan. It
  canonicalizes series-scoped highlight IDs before persistence and rejects a
  non-POV camera unless the effective in-round capture range contains at least
  four target-player samples from the same replay contract used by recording.
  Compatible recorded Takes are consumed once by Capture Intent fingerprint;
  their clip identity and editor-only properties survive reordering, and any
  real-media duration shrink ripples through the replanned Story.
- `request_project_recording`: creates a human-confirmation request; it never
  launches CS2.
- `request_project_export`: creates a human-confirmation request; it never
  launches FFmpeg.

The Rig multi-turn tool loop has no fixed turn ceiling. Cancellation and the
desktop-owned request deadline bound liveness. Provider keys never cross into
the webview or tool output.

## Context assembly

- The durable `AgentSession` is the only conversation truth. The webview first
  persists the current user entry and streaming Assistant placeholder, then
  sends only `sessionId`, the current instruction and Workspace View State to
  the Desktop host. It never uploads a client-built model history.
- The Desktop host builds model history from completed durable entries before
  the active turn. Assistant prose is bounded conversational context; completed
  tool calls and HITL decisions are compact host-owned evidence. Failed turns
  retain completed tool checkpoints, while pending, streaming and cancelled
  placeholders are excluded.
- Every turn begins with a bounded Current Turn Checkpoint containing the exact
  Project revision and a lightweight clip inventory. Full placement, effects,
  keyframes and other editable fields are loaded just in time through targeted
  tools, not replayed in every message.
- The host logs `model_history_messages`, `model_history_bytes` and the larger
  in-process `host_context_bytes` separately so input-token changes can be
  evaluated instead of inferred.
- Vibe CS keeps one single-agent Rig loop. Eight distinct tools do not justify
  a generic Tool Search dispatcher: it would discard provider-side schemas and
  create a second validation surface. Tool Search becomes eligible only when
  trajectory evals show tool-selection failures or the catalog grows beyond a
  small, clearly distinct set.

This follows the smallest-high-signal-context rule and just-in-time retrieval
described in Anthropic's [context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
the targeted tool/output guidance in [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
and OpenAI's recommendation to maximize a single agent before adding orchestration
in [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/).

## Model configuration

Kimi Code exposes both OpenAI- and Anthropic-compatible transports. Vibe CS
uses the existing OpenAI-compatible runtime so K3 shares the same tool loop,
stream events, cancellation, and error handling as other configured models:

```text
provider = kimi-for-coding
model = k3
base URL = https://api.kimi.com/coding/v1
parameter style = OpenAI
```

The API key is read by the desktop host from Vibe CS configuration or, in a
debug build, `VIBE_CS_AGENT_API_KEY`. Never put the key in browser code, command
arguments, logs, screenshots, generated bindings, or documentation.

## Tauri CDP development workflow

Debug Tauri must be started with a loopback CDP port so `agent-browser` can
inspect and operate the actual WebView2 UI:

```powershell
$env:VIBE_CS_CDP_PORT = '9341'
pnpm desktop:dev
```

`VIBE_CS_CDP_PORT` must be an unprivileged numeric port (`1024..65535`). Debug
builds append:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<VIBE_CS_CDP_PORT>
```

Release builds ignore this development surface. Do not bind CDP to a non-loopback
address.

After the desktop window opens, connect `agent-browser` to that CDP endpoint and
test the real Tauri page. A valid UI gate includes:

1. page load and route identity;
2. browser console and page errors;
3. Project revision and Edit Lease behavior;
4. Agent tool progress and direct timeline updates;
5. explicit recording/export confirmation;
6. final cleanup: close the desktop and verify the desktop, worker, CS2/HLAE,
   FFmpeg, and CDP listener are no longer running.

Browser mock mode is useful for layout work but is not evidence for Tauri IPC,
Edit Lease enforcement, recording, export, or an end-to-end Demo-to-MP4 result.
