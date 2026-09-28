//! Bounded, read-only access to locally installed Source 2 assets.
//!
//! The crate parses the documented VPK version 2 directory format without
//! invoking game tools. Every archive offset, path, allocation, and checksum
//! is validated before bytes are returned to callers. A bounded two-dimensional
//! compiled-texture subset converts verified radar assets into browser images;
//! unsupported texture formats are reported instead of guessed.

#![allow(
    clippy::missing_errors_doc,
    reason = "fallible public methods return the crate's documented SourceAssetError variants"
)]

mod cosmetics;
mod cs2;
mod error;
mod geometry_binary;
mod kv3;
mod map_geometry;
mod overview;
mod vpk;
mod vtex;

pub use cosmetics::*;
pub use cs2::*;
pub use error::{Result, SourceAssetError};
pub use geometry_binary::{decode_map_geometry, encode_map_geometry};
pub use kv3::{Kv3Value, decode_physics_kv3};
pub use map_geometry::*;
pub use overview::*;
pub use vpk::*;
pub use vtex::*;

#[cfg(test)]
mod test_support;
