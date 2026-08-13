//! Current-user secret protection backed by Windows DPAPI.

use thiserror::Error;

/// Failure while protecting or unprotecting data with the current Windows user.
#[derive(Debug, Error)]
pub enum UserSecretError {
    #[error("secret is too large for Windows DPAPI")]
    TooLarge,
    #[error("Windows DPAPI could not protect the secret")]
    Protect,
    #[error("Windows DPAPI could not unprotect the secret")]
    Unprotect,
}

#[cfg(windows)]
mod windows_dpapi {
    use std::{ptr, slice};

    use windows::{
        Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
            },
        },
        core::PCWSTR,
    };

    use super::UserSecretError;

    struct DpapiOutput(CRYPT_INTEGER_BLOB);

    impl DpapiOutput {
        fn empty() -> Self {
            Self(CRYPT_INTEGER_BLOB::default())
        }

        fn copy(&self) -> Vec<u8> {
            if self.0.cbData == 0 || self.0.pbData.is_null() {
                return Vec::new();
            }
            // SAFETY: DPAPI returned `pbData` with exactly `cbData` initialized bytes.
            unsafe { slice::from_raw_parts(self.0.pbData, self.0.cbData as usize).to_vec() }
        }
    }

    impl Drop for DpapiOutput {
        fn drop(&mut self) {
            if self.0.pbData.is_null() {
                return;
            }
            // SAFETY: DPAPI allocated this buffer with LocalAlloc. We overwrite its
            // initialized extent before returning it to the matching allocator.
            unsafe {
                ptr::write_bytes(self.0.pbData, 0, self.0.cbData as usize);
                let _ = LocalFree(Some(HLOCAL(self.0.pbData.cast())));
            }
            self.0.pbData = ptr::null_mut();
            self.0.cbData = 0;
        }
    }

    fn input_blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, UserSecretError> {
        Ok(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(bytes.len()).map_err(|_| UserSecretError::TooLarge)?,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }

    pub(super) fn protect(secret: &[u8], purpose: &[u8]) -> Result<Vec<u8>, UserSecretError> {
        let input = input_blob(secret)?;
        let entropy = input_blob(purpose)?;
        let mut output = DpapiOutput::empty();
        // SAFETY: all input blobs borrow valid slices for the duration of the call;
        // `output` is initialized and owns any buffer returned by DPAPI.
        unsafe {
            CryptProtectData(
                &raw const input,
                PCWSTR::null(),
                Some(&raw const entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut output.0,
            )
        }
        .map_err(|_| UserSecretError::Protect)?;
        Ok(output.copy())
    }

    pub(super) fn unprotect(ciphertext: &[u8], purpose: &[u8]) -> Result<Vec<u8>, UserSecretError> {
        let input = input_blob(ciphertext)?;
        let entropy = input_blob(purpose)?;
        let mut output = DpapiOutput::empty();
        // SAFETY: all input blobs borrow valid slices for the duration of the call;
        // `output` is initialized and owns any buffer returned by DPAPI.
        unsafe {
            CryptUnprotectData(
                &raw const input,
                None,
                Some(&raw const entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut output.0,
            )
        }
        .map_err(|_| UserSecretError::Unprotect)?;
        Ok(output.copy())
    }
}

/// Protects `secret` for the current Windows user and the supplied stable purpose.
///
/// The caller persists the returned bytes as its current exact document shape;
/// unreadable payloads are invalid and must be discarded.
///
/// # Errors
///
/// Returns an error if an input exceeds DPAPI limits or Windows cannot protect it.
#[cfg(windows)]
pub fn protect_user_secret(secret: &[u8], purpose: &[u8]) -> Result<Vec<u8>, UserSecretError> {
    windows_dpapi::protect(secret, purpose)
}

/// Unprotects bytes previously returned by [`protect_user_secret`].
///
/// # Errors
///
/// Returns an error if an input exceeds DPAPI limits, was tampered with, belongs
/// to another user or purpose, or Windows cannot recover it.
#[cfg(windows)]
pub fn unprotect_user_secret(
    ciphertext: &[u8],
    purpose: &[u8],
) -> Result<Vec<u8>, UserSecretError> {
    windows_dpapi::unprotect(ciphertext, purpose)
}

#[cfg(all(test, windows))]
mod tests {
    use super::{protect_user_secret, unprotect_user_secret};

    #[test]
    fn current_user_round_trip_and_purpose_binding() {
        let ciphertext =
            protect_user_secret(b"test-secret", b"vibe-cs-test-purpose").expect("protect secret");
        assert_ne!(ciphertext, b"test-secret");
        assert_eq!(
            unprotect_user_secret(&ciphertext, b"vibe-cs-test-purpose").expect("unprotect secret"),
            b"test-secret"
        );
        assert!(unprotect_user_secret(&ciphertext, b"another-purpose").is_err());
    }
}
