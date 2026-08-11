//! Safe, process-free planning boundary for `AdvancedFX` / HLAE workflows.
//!
//! The crate discovers an existing HLAE installation and compiles typed camera
//! plans into reviewable configuration artifacts. It deliberately does not
//! download, inject, launch, or execute HLAE, CS2, console input, or a shell.

mod compile;
mod discovery;
mod error;
mod export;
mod model;
mod validate;

pub use compile::*;
pub use discovery::*;
pub use error::*;
pub use export::*;
pub use model::*;
pub use validate::validate_hlae_plan;
