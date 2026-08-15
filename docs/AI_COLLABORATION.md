# AI collaboration architecture

Vibe CS treats AI as an end-to-end video author behind typed, reviewable boundaries rather than as
an unbounded automation surface. The Agent may read bounded match evidence, select highlights, draft
an executable MP4 task, and—after explicit user confirmation—hand that task to the deterministic
recording state machine. HLAE is an internal capture tool of that workflow, not the Agent's product
output. The model never receives filesystem, shell, process, SQL, or arbitrary HLAE-console access.

## Product flow

The assistant is available from a selected demo or editor project rather than as a detached global
chat room:

1. The user selects one or more demos, an existing edit, and optionally a music asset.
2. Read-only tools assemble a bounded evidence pack from persisted analysis, player events, replay
   frames, media metadata, and the current optimistic project revision.
3. The in-process Rig runtime streams explanations and tool state through the existing Tauri
   channel into the React assistant thread.
4. Planning tools return typed proposals. `draft_video_plan` binds selected evidence to validated
   recording requests and an MP4 output contract; it does not launch a process by itself.
5. A video proposal opens the real recording workspace and selects the proposed shots. The user
   can add/remove shots and edit perspective or lead/tail context in that workspace.
6. The deterministic preview renders tick bounds, estimated duration, output format, safety policy,
   and recovery behavior. Only the final inline confirmation starts managed HLAE/CS2 in offline
   `-insecure` mode; Rust then follows the durable job, encodes the take, and publishes the MP4.

This follows the useful division seen in Descript's co-editor, Premiere's evidence-backed media
search, and Resolve's visible beat markers: conversation lowers the cost of reaching a draft, while
the timeline remains the source of truth.

## Process boundary

```text
assistant-ui (React)
        |
        | Tauri IPC: status, stream request, cancel, confirm proposal
        v
desktop host (Rust)
        |
        | in-process Rig agent; provider keys never cross into the webview
        |
        | typed tool request / response
        v
Rust application/runtime ports -> SQLite, demo parser, recording job, HLAE capture, native MP4
```

The browser never receives a provider key. The desktop host owns cancellation, message and token
ceilings, thread identity, proposal confirmation, and the Rig tool loop. There is no Node process,
JSONL transport, or separately packaged Agent executable; diagnostics remain structured, redacted,
and size-limited.

## Initial tool set

### Read-only

- `read_workspace_context` and `read_demo_evidence`: return bounded selected-workspace, summary,
  highlight, round and player facts; the raw Demo is never sent to the model.
- `search_rounds`, `read_round_context`, `read_round_events`, and `read_player_matchups`: query the
  already parsed timeline through strict result and event bounds.
- `read_highlights`: resolves stable evidence IDs, players and tick windows used by proposal tools.
- `read_editor_timeline` and `read_audio_analysis`: return a bounded project view and measured beat
  evidence without exposing arbitrary media or filesystem reads.
- The recording workspace validates the user's edited `video_render` selection as concrete
  recording requests, performs managed HLAE readiness checks, and creates a short-lived executable
  plan. The chat card does not execute the proposal directly.

### Proposal-only

- `draft_edit_plan`: maps evidence-backed moments to a project patch without applying it.
- `draft_beat_alignment`: aligns selected clips to measured beats while preserving source bounds
  and reports every trim, speed change, and unused clip.
- `draft_video_plan`: creates an evidence-bound `video_render` proposal whose items deserialize as
  concrete recording requests and whose output container is fixed to MP4.
- `navigate_workspace`: returns only one allow-listed destination intent; the host owns navigation.
### Confirmed mutations

- `apply_editor_proposal`: compares the project revision and proposal fingerprint, then commits one
  transaction and snapshot. Conflicts return a new diff instead of overwriting newer work.
- Confirming `video_render` in the recording workspace submits only the plan returned by the
  deterministic preview for the current queue fingerprint.
  The host then follows the durable job through launch, seek, capture, stabilization, native encode,
  and atomic MP4 publication. Legacy HLAE proposal data may still be read for compatibility, but it
  is not exposed as the current Agent video-generation tool.

The first release does not provide generic filesystem, process, shell, SQL, HTTP fetch, JavaScript,
or raw HLAE-console tools.

## Credentials and model policy

Users can configure provider, model, endpoint, and secret in Settings. Responses expose only
presence flags. Secrets remain inside the desktop-owned configuration boundary and are borrowed by
the in-process Rig client only for the lifetime of a request.

For local development only, a debug build can receive `VIBE_CS_AGENT_API_KEY` in its process
environment. The value is never read from another product's configuration, persisted, logged,
placed in command-line arguments, or exposed to the webview. Release builds ignore this override;
product users configure credentials only in Vibe CS Settings.

Kimi Code and the Kimi Open Platform are separate products. A Kimi Code credential uses the
OpenAI-compatible `https://api.kimi.com/coding/v1` endpoint and an entitled model ID such as `k3`,
`k3-256k`. It must not be sent to the Open Platform endpoint. The product Agent exposes only
bounded local Demo, analysis, editor, audio, and video-planning tools; it has no general network tool.
External design research is a maintainer activity during development and is not exposed to users.

## HLAE safety policy

HLAE support is Windows-only and offline-demo-only. Generated launch plans require `-insecure` and
must visibly warn that the resulting game process must not connect to VAC-secured servers. Vibe CS
does not download, inject, or update HLAE silently. Installation discovery and version checks are
read-only; acquisition is an explicit user action from the official AdvancedFX release source.

The compiler allowlists supported Source 2 commands such as `mirv_campath`, `mirv_input`,
`mirv_cmd`, camera FOV, and recording streams. It rejects command separators, control characters,
arbitrary library/script loading, arbitrary filesystem paths, and commands outside the typed model.

## References

- AdvancedFX Source 2 commands: <https://github.com/advancedfx/advancedfx/wiki/Source2%3ACommands>
- Rig framework and OpenAI-compatible providers: <https://www.rig.rs/>
- Kimi Code model and endpoint contract: <https://www.kimi.com/code/docs/en/kimi-code/models.html>
- Descript co-editor: <https://help.descript.com/hc/en-us/articles/36803785502221-Underlord-beta-Your-AI-co-editor-in-Descript>
- Premiere media intelligence: <https://helpx.adobe.com/premiere-pro/using/media-intelligence-and-search-panel.html>
- Resolve beat markers: <https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20_New_Features_Guide.pdf>
