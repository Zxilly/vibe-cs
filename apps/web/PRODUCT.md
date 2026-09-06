# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The React interface runs in the existing Tauri desktop application. Preserve desktop keyboard controls, resizable workspaces and native file dialogs.

## Users

The product supports two equally intentional modes, confirmed by the maintainer on 2026-09-06:

- Editing: CS2 creators selecting footage and producing edited films.
- Analysis: users examining match data, events and tactical replay.

Neither mode is a reduced version of the other. Shared navigation and visual vocabulary connect them; their default information hierarchy follows their different tasks.

## Product Purpose

Turn source CS2 Demo evidence into inspectable match analysis and editable, recordable, exportable projects. Preserve the relationship between match evidence, collected clips, recorded media and the final timeline.

## Capabilities and Constraints

- Existing surfaces include the Demo library, match analysis and replay, project editing, outputs and settings.
- One canonical Editing Document and Project Head govern edits. One Project Timeline Module owns timeline presentation and gestures; shared design/timeline geometry remains authoritative.
- Program Monitor presentation follows Timeline Transport, with stable clip-keyed media pools. A visual redesign must not replace these authorities.
- One Rust Agent runtime, conversation projection, Edit Lease and HITL state govern Agent work.
- Preserve all existing functional capabilities, keyboard equivalents, real source media, source Demo files and exported films.
- The application is unreleased. Follow the repository's AGENTS.md constraints; do not introduce compatibility facades or parallel product implementations.

## Brand Commitments

Vibe CS. The maintainer selected a unified, clear, light blue-gray professional desktop interface. Redesign in the existing Figma design system first, then implement the design in production code.

## Evidence on Hand

- Existing React design primitives and theme.css.
- Figma file N05FPVtPTwWV3ONlE48Fwv: current-state frames and reusable components. Current-state captures have known font and native scrollbar fidelity differences; they are evidence, not proof of pixel equivalence.
- docs/PRODUCT_DESIGN_AUDIT_2026-09-05.md and the associated actual-product screenshots.
- A real revision-12 editing project and existing output; neither is disposable design sample data.

## Product Principles

- Editing leads with the film; analysis leads with evidence.
- Both modes use one understandable vocabulary for navigation, selection, actions and feedback.
- Keep source identity and project context clear across transitions.
- Visual simplification must not remove capabilities or weaken editing and playback invariants.
