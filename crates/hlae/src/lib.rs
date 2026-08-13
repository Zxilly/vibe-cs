//! Safe, process-free boundary for `AdvancedFX` / HLAE movie workflows.
//!
//! The crate compiles typed camera plans, verifies a reviewed portable release,
//! constructs an immutable offline custom-loader invocation, and validates a
//! job-scoped handshake protocol. Network transfer and process execution remain
//! in higher layers; this crate never injects, launches, executes console input,
//! or invokes a shell.

mod bridge;
mod capture_artifacts;
mod compile;
mod discovery;
mod error;
mod export;
mod invocation;
mod managed;
mod model;
mod player_pov_capture;
mod session;
mod session_bootstrap;
mod validate;

pub use bridge::*;
pub use capture_artifacts::*;
pub use compile::*;
pub use discovery::*;
pub use error::*;
pub use export::*;
pub use invocation::*;
pub use managed::*;
pub use model::*;
pub use player_pov_capture::*;
pub use session::*;
pub use session_bootstrap::*;
pub use validate::validate_hlae_plan;
