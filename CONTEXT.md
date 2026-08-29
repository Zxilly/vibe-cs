# Vibe CS Editing

Vibe CS turns CS2 Demo evidence into one durable video project. The Project owns a single revisioned editing document that both a person and the Agent can change.

## Language

**Project**:
A durable creative work with exactly one **Editing Document**, plus its evidence, recording progress, and delivered outputs.
_Avoid_: treating Agent Plan, Montage Project, or Editor Project as separate project kinds

**Project Head**:
The single persisted row that owns a Project identity, current revision, timestamps, and complete **Editing Document**. Conditional writes replace this document at one revision; no other document is an editing authority.
_Avoid_: separate plan, montage, or editor heads

**Editing Document**:
The authoritative revisioned multitrack timeline state of a **Project**. It is multitrack-capable from creation; human edits and accepted Agent edits change this same document.
_Avoid_: Agent Plan, quick-edit copy, multitrack copy

**Editing Lens**:
A presentation of the same **Editing Document** with a particular level of editing detail. A lens controls visibility, not edit authority; changing lens never creates another Project or another editing document.
_Avoid_: mode conversion, project copy, unsynchronized mode

**Project Timeline**:
The unified design-system view that renders and directly manipulates every visible Timeline Track, Timeline Placement, marker, event, playhead, and Materialization from one Editing Document. It owns one frame-snapped geometry for ruler, scroll, zoom, seek, move, trim, keyboard nudge, media resolution, and Edit Lease read-only behavior; one completed gesture submits one Human Edit and never creates a second editable timeline model.
_Avoid_: page-private timeline, duplicate percentage geometry, hidden track asserted only for tests

**Timeline Transport**:
The Project Timeline's single playhead, playback state, and seek command stream. The Program Monitor samples this transport and never exposes a second media progress bar or an independent time authority.
_Avoid_: deriving the playhead from a native video control, resetting to source time zero on clip selection

**Preview Media Pool**:
Stable clip-keyed media elements and decoded radar images retained around the Timeline Transport. Seeks coalesce to the latest requested source time, the previous presented frame remains visible until the target is ready, and changing Timeline Clip identity never rewrites the visible media element's source.
_Avoid_: selected clip directly replacing video src, loading fallback tearing down the prior map, React reconciliation at frame rate

**Ripple Edit**:
A Story Track move, trim, split, or delete that preserves clip order and closes downstream gaps in the same Human Edit. Free-position tracks do not inherit ripple semantics merely because Story does.
_Avoid_: overlapping Story clips after drag, deleting without closing the narrative gap, applying ripple to every track kind

**Agent Panel**:
The workspace surface for Agent instructions, progress, Change Groups, and Agent Cursor state. It is available beside every Editing Lens and never owns a timeline or Project document.
_Avoid_: Agent page, Agent workspace, Agent lens

**Agent Conversation Projection**:
The single UI stream that combines durable AgentSession messages, completed tool calls, HITL decisions, External Execution progress/results, delivery actions, and the Edit Lease state. It renders host-owned truth and sends instructions, cancel, approve, or reject intents; it does not own another Agent runtime.
_Avoid_: inferring running tools from completed outputs, JSON-scanned workflow state, a second chat runtime

**Current Turn Checkpoint**:
A bounded host-owned Project snapshot injected at the start of every Agent turn. It is authoritative over stale project facts in conversation history for read-only answers; edits still re-read the Project Head and bind to the returned revision.
_Avoid_: answering current counts from old assistant messages, replaying the full Project as unbounded transcript

**Agent**:
An automated editing collaborator that can directly change the same **Editing Document** a person is editing. Agent operations may be higher-level than human controls and may change many clips or tracks at once; Cross-Lens Changes remain disclosed, revealable, and undoable.
_Avoid_: Agent workspace, Agent-owned timeline, hidden edit

**Agent Operation**:
A high-leverage editing intention such as replanning a whole timeline, restructuring pacing, or coordinating multiple tracks. It expands into validated Editing Document changes and one Change Group; it does not need a one-to-one human control equivalent.
_Avoid_: mouse macro, mechanical UI-action mirroring, unvalidated document replacement

**Staged Timeline**:
A non-authoritative candidate timeline used by an Agent Operation whose scope requires global consistency. It may be shown as a ghost preview, but it changes the Project Head only after the complete result validates and commits atomically.
_Avoid_: partially committed replan, treating preview as current head

**Project Patch**:
A structured batch of identity-based Editing Document changes bound to a Project, base revision, and declared scope. The Editing Module applies it to a Staged Timeline, preserves unmentioned state, allocates new identities, validates the complete result, and commits one Change Group.
_Avoid_: opaque full-document replacement, model-authored database identity

**Agent Task Ledger**:
Bounded host-owned state for one active Agent Operation: intent, Project revision, scope, evidence handles, progress, and staged patch identity. It keeps old transcript and raw evidence out of repeated model context without becoming a general workflow system.
_Avoid_: full transcript replay, event sourcing, generic orchestration framework

**Human Edit**:
A precise direct manipulation made through the unified editing interface, such as trimming, moving, keyframing, or mixing. Human Edits and Agent Operations share document validation, revision history, and undo semantics without sharing the same granularity.
_Avoid_: requiring a matching Agent tool for every control

**Cross-Lens Change**:
An Agent edit to content or settings not visible in the current **Editing Lens**. It is allowed, but the interface must identify what changed, which lens reveals it, and how to undo it.
_Avoid_: silent hidden mutation, treating lens as permission

**Agent Auto**:
The policy for reversible Agent edits. When enabled, edits apply directly to the **Editing Document** and enter its undo history; when disabled, the same edits remain a preview until accepted.
_Avoid_: permission to record, export, delete media, or perform hidden side effects

**External Execution**:
An operation outside reversible document editing, including CS2/HLAE recording, final export, or local media deletion. External Execution always requires explicit confirmation, regardless of **Agent Auto**.
_Avoid_: treating execution as an Agent edit

**Change Group**:
One intentional set of edits appended to the **Editing Document** revision history, authored by a person or one Agent turn. An Agent Change Group stays open while it holds the **Edit Lease**; validated edits append immediately, and the group closes as completed or interrupted.
_Avoid_: actor-specific history, destructive revision rollback

**Selective Revert**:
A previewable inverse edit for the parts of a **Change Group** that remain safe to undo after later edits. Conflicting fields are disclosed and never overwritten automatically.
_Avoid_: force undo, reverting unrelated later edits

**Edit Lease**:
Exclusive write ownership of one **Project** during an Agent edit turn. While the Agent holds the lease, people may inspect the Project, change Editing Lens, or stop the turn, but every human editing control is read-only.
_Avoid_: concurrent human writes, unexplained disabled controls, lock without cancellation

**Human Selection**:
The clip, track, time range, and **Editing Lens** a person is inspecting. It remains stable while an Agent holds the Edit Lease.
_Avoid_: Agent-owned selection, selection stolen by background work

**Agent Cursor**:
The Project location the Agent is currently reading or changing. It is distinct from **Human Selection** and remains visible as progress even when the person is inspecting elsewhere.
_Avoid_: hidden operation location, reusing Human Selection

**Follow Agent**:
A view preference that scrolls and changes Editing Lens to reveal the **Agent Cursor**. Disabling it changes only the person's viewport, never the Agent's edit authority or progress.
_Avoid_: mandatory focus stealing, pausing the Agent when the user looks elsewhere

**Workspace View State**:
Personal presentation state for one Project workspace, including Editing Lens, Human Selection, playhead, zoom, scroll, expanded tracks, panel layout, Agent Panel visibility, and Follow Agent. It may be restored locally but never advances the Project Head revision.
_Avoid_: storing view state in the Editing Document, shared selection

**Timeline Clip**:
An ordered editing intention in the **Editing Document** with separate **Capture Intent** and **Timeline Placement**. Its identity survives recording, Take selection, lens changes, and accepted Agent edits.
_Avoid_: using separate shot, montage clip, and editor clip identities for the same intention

**Capture Intent**:
The Demo evidence, tick range, target identity, camera, POV, and presentation settings that define what must be recorded for a **Timeline Clip**. Its fingerprint determines Take compatibility.
_Avoid_: timeline position, trim, transition, effect, or mix settings

**Timeline Placement**:
How a **Timeline Clip** uses material inside the Editing Document, including track, timeline position, source range, speed, transitions, effects, keyframes, mix, and enabled state. Placement edits do not change Take compatibility unless they require media outside the Take's real coverage.
_Avoid_: recording specification, Demo evidence identity

**Compatible Take**:
A Take whose capture fingerprint satisfies the current **Capture Intent** and whose media coverage contains the requested **Timeline Placement** source range.
_Avoid_: stale Take fallback, synthetic frame extension

**Story Track**:
The default primary video track that carries the Project's narrative sequence. The Quick lens and Agent Panel emphasize it; the multitrack lens reveals it alongside every other track.
_Avoid_: quick-edit timeline, Agent-only shot list

**Take**:
A recorded media result that can materialize one **Timeline Clip**. A Take is media evidence, not a second timeline entry unless a person explicitly inserts it.
_Avoid_: recorded flag, replacement project

**Materialization**:
The derived relationship between a **Timeline Clip** and usable media, such as unrecorded, recording, recorded, stale, or failed.
_Avoid_: persisted recorded boolean

**Delivery Gate**:
The completeness rule for final export. Every enabled **Timeline Clip** must have compatible materialization; draft preview may show placeholders, but final export never omits or substitutes unresolved clips.
_Avoid_: best-effort export, silent skip, stale Take fallback

**Project Projection**:
Derived, rebuildable Project data used for search, lists, activity, materialization, or delivery status. A projection never accepts edits and never becomes a second editing truth.
_Avoid_: client-side project aggregation, editable read model

## Flagged ambiguities

- “剪辑单” currently means both an Agent Plan document and the visible timeline. Going forward it names the visible editing document or its review state, never a separate project kind.
- “快速剪辑 / 多轨精剪” currently names persisted project kinds. Going forward they are **Editing Lenses** over one Project; “Agent 辅助” becomes the **Agent Panel**, not a lens or project kind.
- “Agent 操作界面” means Agent Operations change the same visible Editing Document and report progress there. It does not require mechanically translating every Agent capability into a sequence of Human Edits or DOM actions.
- Existing pre-release Agent Plan, Montage Project, and Editor Project data is intentionally outside the new model. The product is unreleased, so the unified Editing Document replaces those roots without migration or compatibility behavior; see `AGENTS.md` release status.
- The rewrite includes every current editing action plus recording and export. “Avoid over-design” rejects speculative frameworks and redundant internal guards; it does not defer real existing product capabilities.
- The repository retains one implementation per capability. Legacy Plan, Montage, and Editor code is deleted when its callers move; no adapter or compatibility path remains in the product.
- CopilotKit / AG-UI is not a presentation dependency for the local workbench because it would duplicate the Rust Agent loop, Tauri stream, AgentSession, Edit Lease, and HITL lifecycle. assistant-ui may be evaluated only as a replaceable presentation Adapter over the Agent Conversation Projection; it never becomes a second state authority.

## Example dialogue

> **Editor:** Put the Mirage one-tap before the Inferno defuse, then ask the Agent to tighten the opening.
>
> **Developer:** The reorder changes the Project's Editing Document. The Agent reads that same revision and proposes edits against those Timeline Clip identities.
>
> **Editor:** Lower the background music while I am in the quick lens.
>
> **Developer:** The Agent may change the hidden audio track directly, then reports a Cross-Lens Change with a link to reveal it in the multitrack lens and an undo action.
>
> **Editor:** Did opening the Agent create a different editing mode?
>
> **Developer:** No. The Agent Panel opened beside the current Editing Lens and continues to operate the same Editing Document.
>
> **Editor:** I cannot manually rebalance the entire story with one command. Can the Agent?
>
> **Developer:** Yes. Replanning the timeline is one Agent Operation that expands into many validated changes and one undoable Change Group; it need not exist as one Human Edit.
>
> **Editor:** What happens if a full replan stops halfway?
>
> **Developer:** The Agent was working on a Staged Timeline, so the Project Head is unchanged. Local Agent Operations may retain completed edits, but a globally consistent replan commits only as a whole.
>
> **Editor:** Does a whole-timeline replan let the model replace the Project JSON?
>
> **Developer:** No. It submits a scoped Project Patch over stable identities; the Editing Module builds and validates the Staged Timeline before one atomic commit.
>
> **Editor:** Is the Agent Task Ledger another workflow platform?
>
> **Developer:** No. It is only the bounded state this Agent Operation needs so repeated turns do not resend old transcripts or evidence.
>
> **Editor:** Agent Auto is on. Can it start recording after fixing the timeline?
>
> **Developer:** No. The timeline fix applies directly, but recording is External Execution and still requires explicit confirmation.
>
> **Editor:** Do I need to convert the Project before adding graphics and layered audio?
>
> **Developer:** No. The Editing Document was multitrack-capable from creation; changing Editing Lens only reveals the additional tracks and controls.
>
> **Editor:** I moved a clip after the Agent changed the music. Can I undo only the Agent change?
>
> **Developer:** Yes. Undo appends an inverse Change Group for the music edit; your later clip order remains. If both edits touched the same field, the interface offers a Selective Revert instead of overwriting it.
>
> **Editor:** Can I keep trimming while the Agent changes the project?
>
> **Developer:** No. The Agent holds the Project's Edit Lease for that edit turn. You can watch its progress or stop it; editing becomes available again when the lease is released.
>
> **Editor:** The Agent failed after moving three clips. Did those moves disappear?
>
> **Developer:** No. Its Change Group is interrupted, the three valid moves remain, and you can keep them, undo the whole group, or selectively revert part of it.
>
> **Editor:** I want to inspect the opening while the Agent edits the ending.
>
> **Developer:** Turn off Follow Agent. Your Human Selection stays on the opening, while the Agent Cursor continues to report changes at the ending.
>
> **Editor:** I switched to the multitrack lens and moved the playhead. Did that create a revision?
>
> **Developer:** No. Those are Workspace View State. Only editing content advances the Project Head.
>
> **Editor:** The sixth clip failed to record. Will retry duplicate the first five?
>
> **Developer:** No. Their Materialization is already recorded, so the recording adapter schedules only Timeline Clips without a compatible Take.
>
> **Editor:** Can I preview before the retry finishes?
>
> **Developer:** Yes, with a visible placeholder. The Delivery Gate blocks final export until every enabled Timeline Clip has compatible media.
>
> **Editor:** Which document is saved when I change the timeline?
>
> **Developer:** The conditional write advances the Project Head and replaces its Editing Document. Search and status views update as Project Projections.
>
> **Editor:** I trimmed a recorded clip from seven seconds to four. Must I record again?
>
> **Developer:** No. That changes Timeline Placement inside the Compatible Take. Changing its Demo ticks, POV, or capture presentation would change Capture Intent and make the Take stale.
