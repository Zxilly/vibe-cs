use crate::{
    ConsoleInputPlan, DesktopBackend, ForegroundWindow, NativeWindowHandle, PlatformError,
    PlatformResult, ProcessInfo,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemDesktopBackend;

#[cfg(windows)]
impl DesktopBackend for SystemDesktopBackend {
    fn discover_processes(&self, executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
        windows_impl::discover_processes(executable_name)
    }

    fn foreground_window(&self) -> PlatformResult<ForegroundWindow> {
        windows_impl::foreground_window()
    }

    fn send_console_input(
        &self,
        window: NativeWindowHandle,
        expected_process_id: u32,
        plan: &ConsoleInputPlan,
    ) -> PlatformResult<()> {
        windows_impl::send_console_input(window, expected_process_id, plan)
    }
}

#[cfg(not(windows))]
impl DesktopBackend for SystemDesktopBackend {
    fn discover_processes(&self, _executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
        Err(PlatformError::Unsupported)
    }

    fn foreground_window(&self) -> PlatformResult<ForegroundWindow> {
        Err(PlatformError::Unsupported)
    }

    fn send_console_input(
        &self,
        _window: NativeWindowHandle,
        _expected_process_id: u32,
        _plan: &ConsoleInputPlan,
    ) -> PlatformResult<()> {
        Err(PlatformError::Unsupported)
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::{ffi::c_void, mem::size_of};

    use windows::{
        Win32::{
            Foundation::{ERROR_NO_MORE_FILES, HWND},
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            UI::{
                Input::KeyboardAndMouse::{
                    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
                    KEYEVENTF_UNICODE, SendInput, VIRTUAL_KEY,
                },
                WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
            },
        },
        core::{Error, HRESULT, Owned},
    };

    use super::{
        ConsoleInputPlan, ForegroundWindow, NativeWindowHandle, PlatformError, PlatformResult,
        ProcessInfo,
    };

    pub(super) fn discover_processes(executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
        validate_executable_name(executable_name)?;
        // SAFETY: the returned snapshot is a newly owned kernel handle.
        let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| win32_error("creating process snapshot", &error))?;
        // SAFETY: `raw_snapshot` is uniquely owned by this call and is not a pseudo handle.
        let snapshot = unsafe { Owned::new(raw_snapshot) };
        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).map_err(|_| {
                PlatformError::Windows("PROCESSENTRY32W size does not fit u32".to_owned())
            })?,
            ..Default::default()
        };
        // SAFETY: `entry` is correctly sized and writable for the duration of the call.
        let mut current = unsafe { Process32FirstW(*snapshot, &raw mut entry) };
        let mut processes = Vec::new();
        loop {
            match current {
                Ok(()) => {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                    if entry.th32ProcessID != 0 && name.eq_ignore_ascii_case(executable_name) {
                        processes.push(ProcessInfo {
                            process_id: entry.th32ProcessID,
                            executable_name: name,
                        });
                    }
                    // SAFETY: the snapshot and initialized entry remain valid and exclusive.
                    current = unsafe { Process32NextW(*snapshot, &raw mut entry) };
                }
                Err(error) if is_no_more_files(&error) => break,
                Err(error) => {
                    return Err(win32_error("enumerating process snapshot", &error));
                }
            }
        }
        Ok(processes)
    }

    pub(super) fn foreground_window() -> PlatformResult<ForegroundWindow> {
        // SAFETY: this query has no pointer preconditions and does not transfer ownership.
        let window = unsafe { GetForegroundWindow() };
        if window.0.is_null() {
            return Err(PlatformError::Windows(
                "no foreground window is currently available".to_owned(),
            ));
        }
        let process_id = window_process_id(window)?;
        Ok(ForegroundWindow {
            handle: NativeWindowHandle(window.0 as isize),
            process_id,
        })
    }

    pub(super) fn send_console_input(
        window: NativeWindowHandle,
        expected_process_id: u32,
        plan: &ConsoleInputPlan,
    ) -> PlatformResult<()> {
        if window.0 == 0 || expected_process_id == 0 {
            return Err(PlatformError::InvalidInput(
                "window handle and expected process identifier must be non-zero".to_owned(),
            ));
        }
        if plan.command_utf16.is_empty() || plan.command_utf16.len() > 2_048 {
            return Err(PlatformError::InvalidInput(
                "console input plan has an invalid command length".to_owned(),
            ));
        }
        if !discover_processes("cs2.exe")?
            .iter()
            .any(|process| process.process_id == expected_process_id)
        {
            return Err(PlatformError::ProcessNotFound(format!(
                "cs2.exe with PID {expected_process_id}"
            )));
        }
        let expected_window = HWND(window.0 as *mut c_void);
        send_key_pair(
            expected_window,
            expected_process_id,
            VIRTUAL_KEY(plan.open_console_virtual_key),
            0,
            KEYBD_EVENT_FLAGS::default(),
        )?;
        for unit in &plan.command_utf16 {
            send_key_pair(
                expected_window,
                expected_process_id,
                VIRTUAL_KEY(0),
                *unit,
                KEYEVENTF_UNICODE,
            )?;
        }
        send_key_pair(
            expected_window,
            expected_process_id,
            VIRTUAL_KEY(plan.submit_virtual_key),
            0,
            KEYBD_EVENT_FLAGS::default(),
        )
    }

    fn send_key_pair(
        expected_window: HWND,
        expected_process_id: u32,
        virtual_key: VIRTUAL_KEY,
        scan_code: u16,
        down_flags: KEYBD_EVENT_FLAGS,
    ) -> PlatformResult<()> {
        verify_foreground(expected_window, expected_process_id)?;
        let down = keyboard_input(virtual_key, scan_code, down_flags);
        let up = keyboard_input(virtual_key, scan_code, down_flags | KEYEVENTF_KEYUP);
        let inputs = [down, up];
        // SAFETY: `inputs` is a valid contiguous INPUT slice and cbSize is exact.
        let sent = unsafe {
            SendInput(
                &inputs,
                i32::try_from(size_of::<INPUT>()).map_err(|_| {
                    PlatformError::Windows("INPUT size does not fit i32".to_owned())
                })?,
            )
        };
        if sent == 2 {
            return Ok(());
        }
        let error = Error::from_thread();
        if sent == 1 {
            // Best effort prevents a partial pair from leaving a key held down.
            // SAFETY: `up` is one initialized keyboard INPUT with the exact size.
            let _ =
                unsafe { SendInput(&[up], i32::try_from(size_of::<INPUT>()).unwrap_or_default()) };
        }
        Err(PlatformError::Windows(format!(
            "SendInput delivered {sent}/2 events (HRESULT {:#010x}): {error}",
            error.code().0.cast_unsigned()
        )))
    }

    fn keyboard_input(virtual_key: VIRTUAL_KEY, scan_code: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: virtual_key,
                    wScan: scan_code,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn verify_foreground(expected_window: HWND, expected_process_id: u32) -> PlatformResult<()> {
        // SAFETY: these are non-owning window-manager queries.
        let current = unsafe { GetForegroundWindow() };
        if current != expected_window {
            let actual = if current.0.is_null() {
                0
            } else {
                window_process_id(current).unwrap_or(0)
            };
            return Err(PlatformError::ForegroundMismatch {
                expected: expected_process_id,
                actual,
            });
        }
        let actual = window_process_id(current)?;
        if actual != expected_process_id {
            return Err(PlatformError::ForegroundMismatch {
                expected: expected_process_id,
                actual,
            });
        }
        Ok(())
    }

    fn window_process_id(window: HWND) -> PlatformResult<u32> {
        let mut process_id = 0;
        // SAFETY: `process_id` points to writable storage; HWND is only queried.
        let thread_id = unsafe { GetWindowThreadProcessId(window, Some(&raw mut process_id)) };
        if thread_id == 0 || process_id == 0 {
            let error = Error::from_thread();
            return Err(win32_error("querying window process identifier", &error));
        }
        Ok(process_id)
    }

    fn validate_executable_name(name: &str) -> PlatformResult<()> {
        if name.is_empty()
            || name.len() > 260
            || name.chars().any(char::is_control)
            || name.contains(['/', '\\'])
        {
            return Err(PlatformError::InvalidInput(
                "executable name must be one bounded file name".to_owned(),
            ));
        }
        Ok(())
    }

    fn is_no_more_files(error: &Error) -> bool {
        error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0)
    }

    fn win32_error(operation: &str, error: &Error) -> PlatformError {
        PlatformError::Windows(format!(
            "{operation} failed (HRESULT {:#010x}): {error}",
            error.code().0.cast_unsigned()
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn keyboard_input_plan_uses_paired_unicode_events() {
            let down = keyboard_input(VIRTUAL_KEY(0), b'A'.into(), KEYEVENTF_UNICODE);
            let up = keyboard_input(
                VIRTUAL_KEY(0),
                b'A'.into(),
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
            );
            assert_eq!(down.r#type, INPUT_KEYBOARD);
            assert_eq!(up.r#type, INPUT_KEYBOARD);
            // SAFETY: both union values were initialized through the `ki` field above.
            unsafe {
                assert_eq!(down.Anonymous.ki.wScan, u16::from(b'A'));
                assert!(up.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP));
            }
        }
    }
}
