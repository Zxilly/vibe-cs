//! Safe Windows adapters for CS2 process control and managed configuration.

#![deny(unsafe_op_in_unsafe_fn)]

mod backup;
mod command;
mod disk_space;
mod error;
mod fs_atomic;
mod gsi;
mod hud;
mod loopback_tcp_owner;
mod managed_process_tree;
mod process;
mod secret;
mod sequence_encoder;
mod system;

pub use backup::*;
pub use command::*;
pub use disk_space::*;
pub use error::*;
pub use fs_atomic::{atomic_write, atomic_write_new};
pub use gsi::*;
pub use hud::*;
pub use loopback_tcp_owner::*;
pub use managed_process_tree::*;
pub use process::*;
pub use secret::*;
pub use sequence_encoder::*;
pub use system::*;
