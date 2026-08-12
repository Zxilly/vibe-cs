# AI collaboration architecture

Vibe CS treats AI as a proposal author, not as an unbounded automation surface. The agent may read
bounded match and project evidence, generate an edit or camera proposal, and explain the evidence
behind it. Any operation that changes a project, writes an HLAE configuration, starts capture, or
uses only bounded local tools; maintainers perform external product research outside the product Agent.

## Product flow

The assistant is available from a selected demo or editor project rather than as a detached global
chat room:

1. The user selects one or more demos, an existing edit, and optionally a music asset.
2. Read-only tools assemble a bounded evidence pack from persisted analysis, player events, replay
   frames, media metadata, and the current optimistic project revision.
3. The in-process Rig runtime streams explanations and tool state through the existing Tauri
   channel into the React assistant thread.
4. Planning tools return typed proposals. They do not mutate storage or launch external programs.
5. The UI renders a diff card with timing changes, evidence, confidence, unsupported operations,
   estimated cost, and recovery behavior.
6. The user can reject, revise, or explicitly apply a proposal. Apply commands revalidate the base
   revision and the proposal fingerprint inside Rust before committing.

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
Rust application/runtime ports -> SQLite, demo parser, media, HLAE planner
```

The browser never receives a provider key. The desktop host owns cancellation, message and token
ceilings, thread identity, proposal confirmation, and the Rig tool loop. There is no Node process,
JSONL transport, or separately packaged Agent executable; diagnostics remain structured, redacted,
and size-limited.

## Initial tool set

### Read-only

- `list_demos`: filters persisted demos and returns identifiers plus bounded metadata.
- `get_demo_evidence`: returns score, rounds, players, highlights, utility, and spatial availability
  for selected evidence identifiers; it never sends the raw demo to a model.
- `search_rounds` and `read_round_events`: query the already parsed local timeline through strict
  player, round, tick, purchase-item, winning-side, and event-kind bounds.
- `get_editor_project`: reads one project and its current revision with source availability.
- `get_media_summary`: returns codec, duration, dimensions, audio presence, and managed identity.
- `get_audio_analysis`: returns a measured beat grid, tempo, energy sections, confidence, and
  limitations from the local in-process decoder.
- `preview_hlae_plan`: validates typed camera keyframes and compiles a bounded configuration
  preview without launching HLAE or CS2.

### Proposal-only

- `propose_highlight_edit`: maps evidence-backed moments to a project patch without applying it.
- `propose_beat_alignment`: aligns selected clips to measured beats while preserving source bounds
  and reports every trim, speed change, and unused clip.
- `propose_hlae_camera_path`: creates typed campath/input/command operations; raw console text and
  arbitrary script paths are not accepted.
### Confirmed mutations

- `apply_editor_proposal`: compares the project revision and proposal fingerprint, then commits one
  transaction and snapshot. Conflicts return a new diff instead of overwriting newer work.
- `export_hlae_config`: writes a new managed configuration after validation; it does not inject into
  a running game or join a VAC-secured server.
- `enqueue_capture`: submits only a previously validated recording plan through the existing
  recording state machine.

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
bounded local Demo, analysis, editor, audio, and HLAE tools; it has no general network tool.
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
