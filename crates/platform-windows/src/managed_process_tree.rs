use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(windows)]
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use crate::{PlatformError, PlatformResult, ProcessCancellation};

const MAXIMUM_PROCESS_TREE_ARGUMENTS: usize = 256;
const MAXIMUM_ENVIRONMENT_OVERRIDES: usize = 64;
const MAXIMUM_WINDOWS_STRING_UTF16: usize = 32_767;
const BASELINE_ENVIRONMENT_NAMES: [&str; 33] = [
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "COMPUTERNAME",
    "COMSPEC",
    "DRIVERDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "LOGONSERVER",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PUBLIC",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];
#[cfg(windows)]
const MAXIMUM_JOB_MEMBERS: usize = 256;
#[cfg(windows)]
const MAXIMUM_PROCESS_DISCOVERY_WAIT: Duration = Duration::from_secs(300);
#[cfg(windows)]
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const MANAGED_TERMINATION_EXIT_CODE: u32 = 1_223;

#[cfg(windows)]
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_NO_MORE_FILES, HANDLE,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, GetCurrentProcess,
                GetExitCodeProcess, OpenProcess, PROCESS_INFORMATION, PROCESS_NAME_FORMAT,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
                QueryFullProcessImageNameW, ResumeThread, STARTUPINFOW, TerminateProcess,
                WaitForSingleObject,
            },
        },
    },
    core::{Error, HRESULT, PCWSTR, PWSTR},
};

/// A direct, shell-free process launch whose descendants are owned as one tree.
#[derive(Clone, PartialEq, Eq)]
pub struct ProcessTreeSpec {
    program: PathBuf,
    args: Vec<OsString>,
    current_dir: PathBuf,
    environment_overrides: BTreeMap<String, OsString>,
    track_direct_child: bool,
}

impl std::fmt::Debug for ProcessTreeSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessTreeSpec")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("current_dir", &self.current_dir)
            .field(
                "environment_override_names",
                &self.environment_overrides.keys().collect::<Vec<_>>(),
            )
            .field("track_direct_child", &self.track_direct_child)
            .finish()
    }
}

impl ProcessTreeSpec {
    /// Creates a managed process-tree specification whose working directory is
    /// the canonical executable directory, never the caller's ambient directory.
    ///
    /// # Errors
    ///
    /// Rejects a program that is not an existing absolute file.
    pub fn new(program: impl Into<PathBuf>) -> PlatformResult<Self> {
        let program = program.into();
        let program = canonical_existing_file(&program, "process-tree program")?;
        let current_dir = program.parent().ok_or_else(|| {
            PlatformError::InvalidInput(
                "process-tree program must have an absolute parent directory".to_owned(),
            )
        })?;
        Ok(Self {
            current_dir: current_dir.to_path_buf(),
            program,
            args: Vec::new(),
            environment_overrides: BTreeMap::new(),
            track_direct_child: false,
        })
    }

    /// Launches the primary process outside the owned Job Object, then
    /// identity-checks and retains a termination handle for one exact-path
    /// direct child. The child is deliberately not assigned to the Job Object:
    /// injected games such as CS2 rely on their native process context while
    /// initializing NVIDIA's NVAPI extensions.
    #[must_use]
    pub fn track_direct_child(mut self) -> Self {
        self.track_direct_child = true;
        self
    }

    /// Adds one literal argv element; no command interpreter is involved.
    ///
    /// # Errors
    ///
    /// Rejects control characters or more than 256 arguments.
    pub fn arg(mut self, argument: impl Into<OsString>) -> PlatformResult<Self> {
        if self.args.len() >= MAXIMUM_PROCESS_TREE_ARGUMENTS {
            return Err(PlatformError::InvalidInput(format!(
                "process tree accepts at most {MAXIMUM_PROCESS_TREE_ARGUMENTS} arguments"
            )));
        }
        let argument = argument.into();
        validate_windows_string(&argument, "process-tree argument", true)?;
        self.args.push(argument);
        Ok(self)
    }

    /// Sets an existing absolute working directory.
    ///
    /// # Errors
    ///
    /// Rejects missing, relative, or non-directory paths.
    pub fn current_dir(mut self, directory: impl Into<PathBuf>) -> PlatformResult<Self> {
        let directory = directory.into();
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(PlatformError::InvalidInput(
                "process-tree working directory must be an existing absolute directory".to_owned(),
            ));
        }
        let directory = dunce::canonicalize(&directory).map_err(|error| {
            PlatformError::InvalidInput(format!(
                "process-tree working directory could not be canonicalized: {error}"
            ))
        })?;
        validate_windows_string(
            directory.as_os_str(),
            "process-tree working directory",
            false,
        )?;
        self.current_dir = directory;
        Ok(self)
    }

    /// Adds or replaces one explicit environment value.
    ///
    /// The child receives only a fixed Windows baseline plus overrides declared
    /// through this method; unrelated parent variables are not inherited.
    ///
    /// # Errors
    ///
    /// Rejects unsafe names/values or more than 64 explicit overrides.
    pub fn environment_override(
        mut self,
        name: impl Into<String>,
        value: impl Into<OsString>,
    ) -> PlatformResult<Self> {
        let name = name.into();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || name.as_bytes()[0].is_ascii_digit()
        {
            return Err(PlatformError::InvalidInput(
                "environment override name must be an ASCII identifier".to_owned(),
            ));
        }
        let normalized_name = name.to_ascii_uppercase();
        if BASELINE_ENVIRONMENT_NAMES.contains(&normalized_name.as_str()) {
            return Err(PlatformError::InvalidInput(format!(
                "environment override {normalized_name} is reserved by the Windows baseline"
            )));
        }
        if !self.environment_overrides.contains_key(&normalized_name)
            && self.environment_overrides.len() >= MAXIMUM_ENVIRONMENT_OVERRIDES
        {
            return Err(PlatformError::InvalidInput(format!(
                "process tree accepts at most {MAXIMUM_ENVIRONMENT_OVERRIDES} environment overrides"
            )));
        }
        let value = value.into();
        validate_windows_string(&value, "environment override value", true)?;
        self.environment_overrides.insert(normalized_name, value);
        Ok(self)
    }

    /// Adds an environment override whose value is an existing absolute directory.
    ///
    /// # Errors
    ///
    /// Rejects invalid names and paths that are absent, relative, or not directories.
    pub fn environment_path_override(
        self,
        name: impl Into<String>,
        directory: impl Into<PathBuf>,
    ) -> PlatformResult<Self> {
        let directory = directory.into();
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(PlatformError::InvalidInput(
                "environment path override must be an existing absolute directory".to_owned(),
            ));
        }
        let directory = dunce::canonicalize(directory).map_err(|error| {
            PlatformError::InvalidInput(format!(
                "environment path override could not be canonicalized: {error}"
            ))
        })?;
        self.environment_override(name, directory.into_os_string())
    }
}

fn canonical_existing_file(path: &Path, label: &str) -> PlatformResult<PathBuf> {
    if !path.is_absolute() || !path.is_file() {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must be an existing absolute file"
        )));
    }
    let canonical = dunce::canonicalize(path).map_err(|error| {
        PlatformError::InvalidInput(format!("{label} could not be canonicalized: {error}"))
    })?;
    if !canonical.is_file() {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must resolve to a regular file"
        )));
    }
    validate_windows_string(canonical.as_os_str(), label, false)?;
    Ok(canonical)
}

fn validate_windows_string(value: &OsStr, label: &str, allow_empty: bool) -> PlatformResult<()> {
    let value = value.to_str().ok_or_else(|| {
        PlatformError::InvalidInput(format!("{label} must contain valid Unicode"))
    })?;
    if (!allow_empty && value.is_empty()) || value.contains(['\0', '\r', '\n']) {
        return Err(PlatformError::InvalidInput(format!(
            "{label} is empty or contains control characters"
        )));
    }
    if value.encode_utf16().count() >= MAXIMUM_WINDOWS_STRING_UTF16 {
        return Err(PlatformError::InvalidInput(format!(
            "{label} exceeds the Windows UTF-16 limit"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn quote_windows_argument(argument: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let argument = argument.encode_wide().collect::<Vec<_>>();
    if !argument.is_empty()
        && !argument.iter().any(|unit| {
            *unit == u16::from(b' ') || *unit == u16::from(b'\t') || *unit == u16::from(b'"')
        })
    {
        return argument;
    }

    let mut quoted = Vec::with_capacity(argument.len().saturating_add(2));
    quoted.push(u16::from(b'"'));
    let mut backslashes = 0usize;
    for unit in argument {
        if unit == u16::from(b'\\') {
            backslashes = backslashes.saturating_add(1);
            continue;
        }
        if unit == u16::from(b'"') {
            quoted.extend(std::iter::repeat_n(
                u16::from(b'\\'),
                backslashes.saturating_mul(2).saturating_add(1),
            ));
        } else {
            quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
        }
        backslashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(
        u16::from(b'\\'),
        backslashes.saturating_mul(2),
    ));
    quoted.push(u16::from(b'"'));
    quoted
}

/// Exit information for the primary process (HLAE in the capture pipeline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessTreeExit {
    pub primary_process_id: u32,
    pub exit_code: u32,
}

/// Owns a primary process plus either its Job-owned descendants or one
/// identity-checked direct child retained by an explicit process handle.
#[derive(Debug)]
pub struct ManagedProcessTree {
    primary_process_id: u32,
    track_direct_child: bool,
    #[cfg(windows)]
    job: Option<OwnedWin32Handle>,
    #[cfg(windows)]
    primary_process: Option<OwnedWin32Handle>,
    #[cfg(windows)]
    tracked_direct_child: Arc<Mutex<Option<OwnedWin32Handle>>>,
    #[cfg(windows)]
    cancellation_watcher_stop: Arc<AtomicBool>,
    #[cfg(windows)]
    cancellation_watcher: Option<std::thread::JoinHandle<()>>,
}

impl ManagedProcessTree {
    /// Starts a suspended process, assigns it to a kill-on-close job, then resumes it.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] outside Windows.
    #[cfg(windows)]
    pub fn spawn(
        spec: &ProcessTreeSpec,
        cancellation: &ProcessCancellation,
    ) -> PlatformResult<Self> {
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None });
        }

        let job = create_kill_on_close_job()?;
        let primary_starts_suspended = !spec.track_direct_child;
        let (primary_process, primary_thread, primary_process_id) =
            create_process(spec, primary_starts_suspended)?;
        let launch_result = if primary_starts_suspended {
            assign_and_resume(&job, &primary_process, &primary_thread)
        } else {
            Ok(())
        };
        if let Err(error) = launch_result {
            let _ = terminate_process(&primary_process);
            let _ = terminate_job(&job);
            return Err(error);
        }
        drop(primary_thread);

        let watcher_job = duplicate_handle(&job)?;
        let watcher_primary = spec
            .track_direct_child
            .then(|| duplicate_handle(&primary_process))
            .transpose()?;
        let tracked_direct_child = Arc::new(Mutex::new(None));
        let watcher_direct_child = Arc::clone(&tracked_direct_child);
        let watcher_stop = Arc::new(AtomicBool::new(false));
        let watcher_stop_for_thread = Arc::clone(&watcher_stop);
        let watcher_cancellation = cancellation.clone();
        let watcher = std::thread::Builder::new()
            .name("vibe-cs-managed-process-tree".to_owned())
            .spawn(move || {
                while !watcher_stop_for_thread.load(Ordering::Acquire) {
                    if watcher_cancellation.is_cancelled() {
                        let _ = terminate_job(&watcher_job);
                        let _ = terminate_tracked_process(&watcher_direct_child);
                        if let Some(primary) = &watcher_primary {
                            let _ = terminate_process_if_running(primary);
                        }
                        return;
                    }
                    std::thread::sleep(PROCESS_POLL_INTERVAL);
                }
            })
            .map_err(|error| {
                let _ = terminate_job(&job);
                let _ = terminate_process_if_running(&primary_process);
                PlatformError::Windows(format!(
                    "starting managed process cancellation watcher failed: {error}"
                ))
            })?;

        Ok(Self {
            primary_process_id,
            track_direct_child: spec.track_direct_child,
            job: Some(job),
            primary_process: Some(primary_process),
            tracked_direct_child,
            cancellation_watcher_stop: watcher_stop,
            cancellation_watcher: Some(watcher),
        })
    }

    /// Reports that managed Windows process trees are unavailable.
    ///
    /// # Errors
    ///
    /// Always returns [`PlatformError::Unsupported`].
    #[cfg(not(windows))]
    pub fn spawn(
        _spec: &ProcessTreeSpec,
        _cancellation: &ProcessCancellation,
    ) -> PlatformResult<Self> {
        Err(PlatformError::Unsupported)
    }

    #[must_use]
    pub const fn primary_process_id(&self) -> u32 {
        self.primary_process_id
    }

    /// Waits for the primary process without releasing ownership of descendants.
    ///
    /// # Errors
    ///
    /// Returns a platform or cancellation error.
    #[cfg(windows)]
    pub async fn wait(
        &self,
        cancellation: &ProcessCancellation,
    ) -> PlatformResult<ProcessTreeExit> {
        let process = self.primary_process.as_ref().ok_or_else(|| {
            PlatformError::Windows("managed primary process handle is closed".to_owned())
        })?;
        loop {
            if cancellation.is_cancelled() {
                if let Some(job) = &self.job {
                    let _ = terminate_job(job);
                }
                let _ = terminate_tracked_process(&self.tracked_direct_child);
                if self.track_direct_child {
                    let _ = terminate_process_if_running(process);
                }
                return Err(PlatformError::Cancelled {
                    process_id: Some(self.primary_process_id),
                });
            }
            match wait_for_handle(process, 0)? {
                HandleWait::Signalled => {
                    if cancellation.is_cancelled() {
                        return Err(PlatformError::Cancelled {
                            process_id: Some(self.primary_process_id),
                        });
                    }
                    return Ok(ProcessTreeExit {
                        primary_process_id: self.primary_process_id,
                        exit_code: process_exit_code(process)?,
                    });
                }
                HandleWait::TimedOut => tokio::time::sleep(PROCESS_POLL_INTERVAL).await,
            }
        }
    }

    #[cfg(not(windows))]
    pub fn wait(
        &self,
        _cancellation: &ProcessCancellation,
    ) -> impl std::future::Future<Output = PlatformResult<ProcessTreeExit>> + Send + use<> {
        std::future::ready(Err(PlatformError::Unsupported))
    }

    /// Finds exactly one job member whose full executable path matches `expected_executable`.
    ///
    /// # Errors
    ///
    /// Rejects invalid paths, ambiguity, cancellation, and timeout.
    #[cfg(windows)]
    pub async fn wait_for_unique_process(
        &self,
        expected_executable: &Path,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> PlatformResult<u32> {
        if timeout > MAXIMUM_PROCESS_DISCOVERY_WAIT {
            return Err(PlatformError::InvalidInput(format!(
                "managed process discovery timeout may not exceed {} seconds",
                MAXIMUM_PROCESS_DISCOVERY_WAIT.as_secs()
            )));
        }
        let expected_executable =
            canonical_existing_file(expected_executable, "expected job executable")?;
        let job = self.job.as_ref().ok_or_else(|| {
            PlatformError::Windows("managed process-tree job handle is closed".to_owned())
        })?;
        let deadline = tokio::time::Instant::now() + timeout;
        let mut observed_direct_children = BTreeSet::new();
        loop {
            if cancellation.is_cancelled() {
                let _ = terminate_job(job);
                let _ = terminate_tracked_process(&self.tracked_direct_child);
                if self.track_direct_child {
                    if let Ok(children) = query_direct_child_process_ids(self.primary_process_id) {
                        for process_id in children {
                            if let Ok(process) =
                                open_tracked_direct_child(process_id, &expected_executable)
                            {
                                let _ = terminate_process_if_running(&process);
                            }
                        }
                    }
                    if let Some(primary) = &self.primary_process {
                        let _ = terminate_process_if_running(primary);
                    }
                }
                return Err(PlatformError::Cancelled {
                    process_id: Some(self.primary_process_id),
                });
            }
            let mut matches = Vec::new();
            for process_id in query_job_process_ids(job)? {
                if let Some(actual_executable) = query_process_image(process_id)
                    && same_file::is_same_file(&actual_executable, &expected_executable)
                        .unwrap_or(false)
                {
                    matches.push(process_id);
                }
            }
            if matches.is_empty() && self.track_direct_child {
                let candidates = query_direct_child_process_ids(self.primary_process_id)?;
                for process_id in candidates {
                    if let Some(actual_executable) = query_process_image(process_id) {
                        observed_direct_children
                            .insert(format!("{process_id}:{}", actual_executable.display()));
                        if same_file::is_same_file(&actual_executable, &expected_executable)
                            .unwrap_or(false)
                        {
                            matches.push(process_id);
                        }
                    }
                }
                if let [process_id] = matches.as_slice() {
                    let process = open_tracked_direct_child(*process_id, &expected_executable)?;
                    let mut tracked = self.tracked_direct_child.lock().map_err(|_| {
                        PlatformError::Windows(
                            "tracked direct-child process lock was poisoned".to_owned(),
                        )
                    })?;
                    if tracked.is_some() {
                        return Err(PlatformError::InvalidInput(
                            "managed process tree already tracks a direct child".to_owned(),
                        ));
                    }
                    *tracked = Some(process);
                }
            }
            match matches.as_slice() {
                [process_id] => return Ok(*process_id),
                [] => {}
                _ => {
                    return Err(PlatformError::InvalidInput(format!(
                        "managed job contains multiple processes for {}",
                        expected_executable.display()
                    )));
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(PlatformError::ProcessNotFound(format!(
                    "unique managed process {} within {} ms; observed direct children: {}",
                    expected_executable.display(),
                    timeout.as_millis(),
                    if observed_direct_children.is_empty() {
                        "none".to_owned()
                    } else {
                        observed_direct_children
                            .into_iter()
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                )));
            }
            tokio::time::sleep(PROCESS_POLL_INTERVAL).await;
        }
    }

    #[cfg(not(windows))]
    pub fn wait_for_unique_process(
        &self,
        _expected_executable: &Path,
        _timeout: Duration,
        _cancellation: &ProcessCancellation,
    ) -> impl std::future::Future<Output = PlatformResult<u32>> + Send + use<> {
        std::future::ready(Err(PlatformError::Unsupported))
    }

    /// Explicitly terminates and closes the whole managed process tree.
    ///
    /// # Errors
    ///
    /// Returns a platform error if termination fails.
    #[cfg(windows)]
    pub fn close(mut self) -> PlatformResult<()> {
        self.shutdown()
    }

    /// Reports that managed Windows process trees are unavailable.
    ///
    /// # Errors
    ///
    /// Always returns [`PlatformError::Unsupported`].
    #[cfg(not(windows))]
    pub fn close(self) -> PlatformResult<()> {
        Err(PlatformError::Unsupported)
    }

    #[cfg(windows)]
    fn shutdown(&mut self) -> PlatformResult<()> {
        self.cancellation_watcher_stop
            .store(true, Ordering::Release);
        let termination = self.job.as_ref().map_or(Ok(()), terminate_job);
        let direct_child_termination = terminate_tracked_process(&self.tracked_direct_child);
        let primary_termination = if self.track_direct_child {
            self.primary_process
                .as_ref()
                .map_or(Ok(()), terminate_process_if_running)
        } else {
            Ok(())
        };
        if let Some(watcher) = self.cancellation_watcher.take() {
            let _ = watcher.join();
        }
        self.primary_process.take();
        self.job.take();
        termination
            .and(direct_child_termination)
            .and(primary_termination)
    }
}

#[cfg(windows)]
impl Drop for ManagedProcessTree {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct OwnedWin32Handle(isize);

#[cfg(windows)]
impl OwnedWin32Handle {
    fn new(handle: HANDLE, operation: &str) -> PlatformResult<Self> {
        if handle.is_invalid() {
            return Err(PlatformError::Windows(format!(
                "{operation} returned an invalid handle"
            )));
        }
        Ok(Self(handle.0 as isize))
    }

    fn raw(&self) -> HANDLE {
        HANDLE(self.0 as *mut std::ffi::c_void)
    }
}

#[cfg(windows)]
impl Drop for OwnedWin32Handle {
    fn drop(&mut self) {
        // SAFETY: this instance exclusively owns the valid Win32 handle.
        let _ = unsafe { CloseHandle(self.raw()) };
    }
}

#[cfg(windows)]
fn create_kill_on_close_job() -> PlatformResult<OwnedWin32Handle> {
    // SAFETY: null security attributes and name request an unnamed job with default security.
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| win32_error("creating managed process job", &error))?;
    let handle = OwnedWin32Handle::new(handle, "creating managed process job")?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = u32::try_from(std::mem::size_of_val(&limits)).map_err(|_| {
        PlatformError::Windows("job limit information size did not fit u32".to_owned())
    })?;
    // SAFETY: the pointer and byte length refer to `limits` for the duration of the call.
    unsafe {
        SetInformationJobObject(
            handle.raw(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size,
        )
    }
    .map_err(|error| win32_error("enabling kill-on-close job limit", &error))?;
    Ok(handle)
}

#[cfg(windows)]
fn create_process(
    spec: &ProcessTreeSpec,
    suspended: bool,
) -> PlatformResult<(OwnedWin32Handle, OwnedWin32Handle, u32)> {
    let mut command_line = quote_windows_argument(spec.program.as_os_str());
    for argument in &spec.args {
        command_line.push(u16::from(b' '));
        command_line.extend(quote_windows_argument(argument));
    }
    command_line.push(0);
    if command_line.len() > MAXIMUM_WINDOWS_STRING_UTF16 {
        return Err(PlatformError::InvalidInput(
            "managed process command line exceeds the Windows UTF-16 limit".to_owned(),
        ));
    }
    let application_name = wide_nul(spec.program.as_os_str());
    let current_directory = wide_nul(spec.current_dir.as_os_str());
    let environment = build_environment_block(spec)?;
    let mut startup = STARTUPINFOW {
        cb: u32::try_from(std::mem::size_of::<STARTUPINFOW>()).map_err(|_| {
            PlatformError::Windows("startup information size did not fit u32".to_owned())
        })?,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    let mut creation_flags = CREATE_UNICODE_ENVIRONMENT;
    if suspended {
        creation_flags |= CREATE_SUSPENDED;
    }
    // SAFETY: all pointers reference live, NUL-terminated mutable buffers and output structs;
    // handle inheritance is disabled and no security pointers are supplied.
    unsafe {
        CreateProcessW(
            PCWSTR(application_name.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            creation_flags,
            Some(environment.as_ptr().cast()),
            PCWSTR(current_directory.as_ptr()),
            &raw mut startup,
            &raw mut process,
        )
    }
    .map_err(|error| win32_error("creating suspended managed process", &error))?;
    if process.hProcess.is_invalid() || process.hThread.is_invalid() {
        if !process.hProcess.is_invalid() {
            // SAFETY: CreateProcessW returned this process handle but an invalid companion handle.
            let _ = unsafe { TerminateProcess(process.hProcess, MANAGED_TERMINATION_EXIT_CODE) };
            // SAFETY: the raw process handle has not been transferred to an owner.
            let _ = unsafe { CloseHandle(process.hProcess) };
        }
        if !process.hThread.is_invalid() {
            // SAFETY: the raw thread handle has not been transferred to an owner.
            let _ = unsafe { CloseHandle(process.hThread) };
        }
        return Err(PlatformError::Windows(
            "CreateProcessW returned incomplete process handles".to_owned(),
        ));
    }
    let primary_process = OwnedWin32Handle(process.hProcess.0 as isize);
    let primary_thread = OwnedWin32Handle(process.hThread.0 as isize);
    Ok((primary_process, primary_thread, process.dwProcessId))
}

#[cfg(windows)]
fn assign_and_resume(
    job: &OwnedWin32Handle,
    process: &OwnedWin32Handle,
    thread: &OwnedWin32Handle,
) -> PlatformResult<()> {
    // SAFETY: the job and process handles are valid and live.
    unsafe { AssignProcessToJobObject(job.raw(), process.raw()) }
        .map_err(|error| win32_error("assigning suspended process to job", &error))?;
    // SAFETY: the handle owns the primary thread, which CreateProcessW created suspended.
    let previous_suspend_count = unsafe { ResumeThread(thread.raw()) };
    if previous_suspend_count == u32::MAX {
        return Err(win32_last_error("resuming managed primary thread"));
    }
    if previous_suspend_count != 1 {
        return Err(PlatformError::Windows(format!(
            "managed primary thread had unexpected suspend count {previous_suspend_count}"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn build_environment_block(spec: &ProcessTreeSpec) -> PlatformResult<Vec<u16>> {
    let mut values = BTreeMap::<String, OsString>::new();
    for name in BASELINE_ENVIRONMENT_NAMES {
        if let Some(value) = std::env::var_os(name) {
            validate_windows_string(&value, "baseline environment value", true)?;
            values.insert(name.to_owned(), value);
        }
    }
    values.extend(spec.environment_overrides.clone());
    let mut block = Vec::new();
    for (name, value) in values {
        let entry = OsString::from(format!("{name}={}", value.to_string_lossy()));
        block.extend(wide_nul(&entry));
    }
    block.push(0);
    if block.len() > MAXIMUM_WINDOWS_STRING_UTF16 {
        return Err(PlatformError::InvalidInput(
            "managed process environment exceeds the Windows UTF-16 limit".to_owned(),
        ));
    }
    Ok(block)
}

#[cfg(windows)]
fn wide_nul(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn duplicate_handle(source: &OwnedWin32Handle) -> PlatformResult<OwnedWin32Handle> {
    let mut duplicate = HANDLE::default();
    let current = unsafe { GetCurrentProcess() };
    // SAFETY: source is live; destination points to a valid HANDLE output slot.
    unsafe {
        DuplicateHandle(
            current,
            source.raw(),
            current,
            &raw mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }
    .map_err(|error| win32_error("duplicating managed job handle", &error))?;
    OwnedWin32Handle::new(duplicate, "duplicating managed job handle")
}

#[cfg(windows)]
fn terminate_job(job: &OwnedWin32Handle) -> PlatformResult<()> {
    // SAFETY: job is a valid owned Job Object handle.
    unsafe { TerminateJobObject(job.raw(), MANAGED_TERMINATION_EXIT_CODE) }
        .map_err(|error| win32_error("terminating managed process tree", &error))
}

#[cfg(windows)]
fn terminate_process(process: &OwnedWin32Handle) -> PlatformResult<()> {
    // SAFETY: process is a valid owned process handle.
    unsafe { TerminateProcess(process.raw(), MANAGED_TERMINATION_EXIT_CODE) }
        .map_err(|error| win32_error("terminating unassigned managed process", &error))
}

#[cfg(windows)]
fn terminate_process_if_running(process: &OwnedWin32Handle) -> PlatformResult<()> {
    if matches!(wait_for_handle(process, 0)?, HandleWait::Signalled) {
        return Ok(());
    }
    terminate_process(process)
}

#[cfg(windows)]
enum HandleWait {
    Signalled,
    TimedOut,
}

#[cfg(windows)]
fn wait_for_handle(handle: &OwnedWin32Handle, timeout_ms: u32) -> PlatformResult<HandleWait> {
    // SAFETY: handle is live and has synchronization rights from CreateProcessW.
    match unsafe { WaitForSingleObject(handle.raw(), timeout_ms) } {
        WAIT_OBJECT_0 => Ok(HandleWait::Signalled),
        WAIT_TIMEOUT => Ok(HandleWait::TimedOut),
        _ => Err(win32_last_error("waiting for managed primary process")),
    }
}

#[cfg(windows)]
fn process_exit_code(process: &OwnedWin32Handle) -> PlatformResult<u32> {
    let mut exit_code = 0;
    // SAFETY: process is a live process handle and the output pointer is valid.
    unsafe { GetExitCodeProcess(process.raw(), &raw mut exit_code) }
        .map_err(|error| win32_error("reading managed primary process exit code", &error))?;
    Ok(exit_code)
}

#[cfg(windows)]
fn query_direct_child_process_ids(parent_process_id: u32) -> PlatformResult<Vec<u32>> {
    // SAFETY: the returned snapshot is a newly owned kernel handle.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| win32_error("creating managed child process snapshot", &error))?;
    let snapshot = OwnedWin32Handle::new(snapshot, "creating managed child process snapshot")?;
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).map_err(|_| {
            PlatformError::Windows("PROCESSENTRY32W size did not fit u32".to_owned())
        })?,
        ..Default::default()
    };
    // SAFETY: `entry` is correctly sized and writable for the snapshot enumeration.
    let mut current = unsafe { Process32FirstW(snapshot.raw(), &raw mut entry) };
    let mut children = Vec::new();
    loop {
        match current {
            Ok(()) => {
                if entry.th32ProcessID != 0 && entry.th32ParentProcessID == parent_process_id {
                    children.push(entry.th32ProcessID);
                }
                // SAFETY: snapshot and entry remain valid and exclusive.
                current = unsafe { Process32NextW(snapshot.raw(), &raw mut entry) };
            }
            Err(error) if is_no_more_files(&error) => break,
            Err(error) => {
                return Err(win32_error(
                    "enumerating managed child process snapshot",
                    &error,
                ));
            }
        }
    }
    Ok(children)
}

#[cfg(windows)]
fn open_tracked_direct_child(
    process_id: u32,
    expected_executable: &Path,
) -> PlatformResult<OwnedWin32Handle> {
    // SAFETY: the identity-matched PID is opened only with the rights required
    // to query, wait, and terminate it during cancellation or shutdown.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            false,
            process_id,
        )
    }
    .map_err(|error| win32_error("opening tracked direct child", &error))?;
    let process = OwnedWin32Handle::new(process, "opening tracked direct child")?;
    let actual_executable = query_process_image_from_handle(&process).ok_or_else(|| {
        PlatformError::Windows("querying tracked direct-child image failed".to_owned())
    })?;
    if !same_file::is_same_file(&actual_executable, expected_executable).unwrap_or(false) {
        return Err(PlatformError::InvalidInput(format!(
            "tracked direct child changed identity from {} to {}",
            expected_executable.display(),
            actual_executable.display()
        )));
    }
    Ok(process)
}

#[cfg(windows)]
fn terminate_tracked_process(tracked: &Mutex<Option<OwnedWin32Handle>>) -> PlatformResult<()> {
    let tracked = tracked.lock().map_err(|_| {
        PlatformError::Windows("tracked direct-child process lock was poisoned".to_owned())
    })?;
    tracked
        .as_ref()
        .map_or(Ok(()), terminate_process_if_running)
}

#[cfg(windows)]
fn is_no_more_files(error: &Error) -> bool {
    error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0)
}

#[cfg(windows)]
fn query_job_process_ids(job: &OwnedWin32Handle) -> PlatformResult<Vec<u32>> {
    #[repr(C)]
    struct ProcessIdBuffer {
        header: JOBOBJECT_BASIC_PROCESS_ID_LIST,
        additional_ids: [usize; MAXIMUM_JOB_MEMBERS - 1],
    }
    let mut buffer = ProcessIdBuffer {
        header: JOBOBJECT_BASIC_PROCESS_ID_LIST::default(),
        additional_ids: [0; MAXIMUM_JOB_MEMBERS - 1],
    };
    let size = u32::try_from(std::mem::size_of::<ProcessIdBuffer>()).map_err(|_| {
        PlatformError::Windows("job process list buffer size did not fit u32".to_owned())
    })?;
    // SAFETY: the output pointer refers to a buffer whose layout starts with the documented
    // variable-sized JOBOBJECT_BASIC_PROCESS_ID_LIST header and has capacity for 256 IDs.
    let query = unsafe {
        QueryInformationJobObject(
            Some(job.raw()),
            JobObjectBasicProcessIdList,
            (&raw mut buffer).cast(),
            size,
            None,
        )
    };
    let assigned = usize::try_from(buffer.header.NumberOfAssignedProcesses).map_err(|_| {
        PlatformError::Windows("managed job process count did not fit usize".to_owned())
    })?;
    let listed = usize::try_from(buffer.header.NumberOfProcessIdsInList).map_err(|_| {
        PlatformError::Windows("managed job listed process count did not fit usize".to_owned())
    })?;
    if assigned > MAXIMUM_JOB_MEMBERS {
        return Err(PlatformError::Windows(format!(
            "managed job contains {assigned} processes; maximum supported is {MAXIMUM_JOB_MEMBERS}"
        )));
    }
    query.map_err(|error| win32_error("querying managed job process members", &error))?;
    if assigned != listed {
        return Err(PlatformError::Windows(format!(
            "managed job membership changed during its bounded query ({assigned} assigned, {listed} listed)"
        )));
    }
    // SAFETY: QueryInformationJobObject reported `listed <= MAXIMUM_JOB_MEMBERS`; the header's
    // trailing one-element array is followed immediately by `additional_ids` in this repr(C) buffer.
    let raw_ids =
        unsafe { std::slice::from_raw_parts(buffer.header.ProcessIdList.as_ptr(), listed) };
    raw_ids
        .iter()
        .map(|value| {
            u32::try_from(*value).map_err(|_| {
                PlatformError::Windows("managed process ID did not fit u32".to_owned())
            })
        })
        .collect()
}

#[cfg(windows)]
fn query_process_image(process_id: u32) -> Option<PathBuf> {
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let handle = OwnedWin32Handle::new(handle, "opening managed job member").ok()?;
    query_process_image_from_handle(&handle)
}

#[cfg(windows)]
fn query_process_image_from_handle(handle: &OwnedWin32Handle) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    let mut buffer = vec![0u16; 32_768];
    let mut length = u32::try_from(buffer.len()).ok()?;
    // SAFETY: the process handle and writable UTF-16 output buffer are valid.
    unsafe {
        QueryFullProcessImageNameW(
            handle.raw(),
            PROCESS_NAME_FORMAT::default(),
            PWSTR(buffer.as_mut_ptr()),
            &raw mut length,
        )
    }
    .ok()?;
    buffer.truncate(usize::try_from(length).ok()?);
    Some(PathBuf::from(OsString::from_wide(&buffer)))
}

#[cfg(windows)]
fn win32_error(operation: &str, error: &windows::core::Error) -> PlatformError {
    PlatformError::Windows(format!("{operation}: {error}"))
}

#[cfg(windows)]
fn win32_last_error(operation: &str) -> PlatformError {
    win32_error(operation, &windows::core::Error::from_thread())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_tree_requires_an_existing_absolute_program() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ManagedProcessTree>();

        assert!(matches!(
            ProcessTreeSpec::new("relative\\hlae.exe"),
            Err(PlatformError::InvalidInput(_))
        ));
        let missing = std::env::temp_dir().join("vibe-cs-missing-hlae.exe");
        assert!(matches!(
            ProcessTreeSpec::new(missing),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn process_tree_uses_dotnet_compatible_canonical_paths() {
        let spec = ProcessTreeSpec::new(std::env::current_exe().unwrap()).unwrap();
        assert!(
            !spec
                .program
                .as_os_str()
                .to_string_lossy()
                .starts_with(r"\\?\")
        );
        assert!(
            !spec
                .current_dir
                .as_os_str()
                .to_string_lossy()
                .starts_with(r"\\?\")
        );
    }

    #[cfg(windows)]
    #[test]
    fn process_tree_preserves_the_standard_windows_desktop_environment() {
        let spec = ProcessTreeSpec::new(std::env::current_exe().unwrap()).unwrap();
        let block = build_environment_block(&spec).unwrap();
        let entries = String::from_utf16_lossy(&block)
            .split('\0')
            .filter_map(|entry| entry.split_once('=').map(|(name, _)| name.to_owned()))
            .collect::<BTreeSet<_>>();

        for required in [
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "USERDOMAIN",
            "USERNAME",
            "USERPROFILE",
        ] {
            assert!(
                entries.contains(required),
                "managed desktop environment omitted {required}"
            );
        }
        assert!(
            !entries.contains("CODEX_THREAD_ID"),
            "unreviewed parent variables must remain excluded"
        );
    }

    #[test]
    fn process_tree_rejects_controls_and_redacts_environment_values() {
        let executable = std::env::current_exe().unwrap();
        let spec = ProcessTreeSpec::new(executable)
            .unwrap()
            .arg("safe literal argument")
            .unwrap()
            .environment_override("USRLOCALCSGO", "secret configuration path")
            .unwrap();
        assert!(format!("{spec:?}").contains("USRLOCALCSGO"));
        assert!(!format!("{spec:?}").contains("secret configuration path"));
        assert!(matches!(
            spec.clone().arg("unsafe\nargument"),
            Err(PlatformError::InvalidInput(_))
        ));
        assert!(matches!(
            spec.environment_override("BAD=NAME", "value"),
            Err(PlatformError::InvalidInput(_))
        ));
        let executable = std::env::current_exe().unwrap();
        assert!(matches!(
            ProcessTreeSpec::new(executable)
                .unwrap()
                .environment_override("SYSTEMROOT", r"C:\untrusted"),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn managed_process_tree_is_explicitly_unsupported_off_windows() {
        let executable = std::env::current_exe().unwrap();
        let spec = ProcessTreeSpec::new(executable).unwrap();
        let cancellation = ProcessCancellation::default();
        assert!(matches!(
            ManagedProcessTree::spawn(&spec, &cancellation),
            Err(PlatformError::Unsupported)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_argv_quoting_preserves_spaces_quotes_and_trailing_backslashes() {
        let cases = [
            ("", "\"\""),
            ("plain", "plain"),
            ("two words", "\"two words\""),
            (r#"say "hello""#, r#""say \"hello\"""#),
            (r"C:\path with space\", r#""C:\path with space\\""#),
        ];
        for (input, expected) in cases {
            let quoted = String::from_utf16(&quote_windows_argument(OsStr::new(input))).unwrap();
            assert_eq!(quoted, expected, "input {input:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn pre_cancelled_tree_never_starts_a_primary_process() {
        let spec = ProcessTreeSpec::new(std::env::current_exe().unwrap()).unwrap();
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            ManagedProcessTree::spawn(&spec, &cancellation),
            Err(PlatformError::Cancelled { process_id: None })
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "spawns a nested Windows test process"]
    fn managed_tree_exit_helper() {
        if std::env::var_os("VIBE_CS_MANAGED_EXIT_HELPER").is_none() {
            return;
        }
        assert!(
            std::env::var_os("CODEX_THREAD_ID").is_none(),
            "unlisted parent environment must not leak into the managed process"
        );
        assert!(
            std::env::var_os("USERPROFILE").is_some(),
            "the standard Windows desktop environment must remain available"
        );
        let expected_directory = PathBuf::from(
            std::env::var_os("VIBE_CS_EXPECTED_CURRENT_DIR").expect("expected current directory"),
        );
        assert_eq!(
            dunce::canonicalize(std::env::current_dir().unwrap()).unwrap(),
            expected_directory
        );
        std::process::exit(37);
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawns a real suspended Windows process and Job Object"]
    async fn managed_tree_reports_primary_pid_and_exit_code() {
        let executable = std::env::current_exe().unwrap();
        let expected_directory = dunce::canonicalize(executable.parent().unwrap()).unwrap();
        let spec = nested_test_spec("managed_tree_exit_helper")
            .environment_override("VIBE_CS_MANAGED_EXIT_HELPER", "1")
            .unwrap()
            .environment_path_override("VIBE_CS_EXPECTED_CURRENT_DIR", expected_directory)
            .unwrap();
        let cancellation = ProcessCancellation::default();
        let tree = ManagedProcessTree::spawn(&spec, &cancellation).unwrap();
        assert_ne!(tree.primary_process_id(), 0);
        let outcome = tokio::time::timeout(Duration::from_secs(10), tree.wait(&cancellation))
            .await
            .expect("nested process wait timed out")
            .unwrap();
        assert_eq!(outcome.primary_process_id, tree.primary_process_id());
        assert_eq!(outcome.exit_code, 37);
        tree.close().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "helper for the managed descendant Job Object smoke test"]
    fn managed_tree_descendant_helper() {
        if std::env::var_os("VIBE_CS_MANAGED_DESCENDANT_HELPER").is_none() {
            return;
        }
        let system_root = std::env::var_os("SYSTEMROOT").expect("SYSTEMROOT baseline");
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let mut child = std::process::Command::new(ping)
            .args(["-t", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn ping descendant");
        let pid_file =
            PathBuf::from(std::env::var_os("VIBE_CS_MANAGED_PID_FILE").expect("managed PID file"));
        std::fs::write(pid_file, child.id().to_string()).expect("write descendant PID");
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "helper for the managed breakaway descendant smoke test"]
    fn managed_tree_breakaway_descendant_helper() {
        if std::env::var_os("VIBE_CS_MANAGED_BREAKAWAY_HELPER").is_none() {
            return;
        }
        let system_root = std::env::var_os("SYSTEMROOT").expect("SYSTEMROOT baseline");
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let mut child = std::process::Command::new(ping)
            .args(["-t", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn breakaway ping descendant");
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawns a breakaway ping.exe and proves it is tracked outside the Job Object"]
    async fn managed_tree_tracks_an_exact_direct_breakaway_child_without_reparenting() {
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };

        let spec = nested_test_spec("managed_tree_breakaway_descendant_helper")
            .environment_override("VIBE_CS_MANAGED_BREAKAWAY_HELPER", "1")
            .unwrap()
            .track_direct_child();
        let system_root = std::env::var_os("SYSTEMROOT").unwrap();
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let cancellation = ProcessCancellation::default();
        let tree = ManagedProcessTree::spawn(&spec, &cancellation).unwrap();
        let ping_process_id = tree
            .wait_for_unique_process(&ping, Duration::from_secs(10), &cancellation)
            .await
            .unwrap();
        // SAFETY: the PID was identity-checked and retained by the managed tree.
        let ping_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                ping_process_id,
            )
        }
        .unwrap();
        let ping_handle = OwnedWin32Handle::new(ping_handle, "opening tracked ping").unwrap();
        let assigned_to_vibe_job = query_job_process_ids(tree.job.as_ref().expect("managed job"))
            .unwrap()
            .contains(&ping_process_id);
        assert!(
            !assigned_to_vibe_job,
            "a tracked HLAE game child must retain its native process context"
        );
        tree.close().unwrap();
        assert!(matches!(
            wait_for_handle(&ping_handle, 5_000).unwrap(),
            HandleWait::Signalled
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawns ping.exe and proves explicit close kills the complete Windows process tree"]
    async fn managed_tree_finds_exact_descendant_and_close_kills_it() {
        use windows::Win32::System::Threading::PROCESS_SYNCHRONIZE;

        let temporary = tempfile::tempdir().unwrap();
        let pid_file = temporary.path().join("ping.pid");
        let spec = nested_test_spec("managed_tree_descendant_helper")
            .environment_override("VIBE_CS_MANAGED_DESCENDANT_HELPER", "1")
            .unwrap()
            .environment_override("VIBE_CS_MANAGED_PID_FILE", pid_file.as_os_str())
            .unwrap();
        let system_root = std::env::var_os("SYSTEMROOT").unwrap();
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let cancellation = ProcessCancellation::default();
        let tree = ManagedProcessTree::spawn(&spec, &cancellation).unwrap();
        let ping_process_id = tree
            .wait_for_unique_process(&ping, Duration::from_secs(10), &cancellation)
            .await
            .unwrap();
        assert_ne!(ping_process_id, tree.primary_process_id());

        // SAFETY: the PID came from the bounded job membership query and access is read/wait only.
        let ping_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                ping_process_id,
            )
        }
        .unwrap();
        let ping_handle = OwnedWin32Handle::new(ping_handle, "opening smoke-test ping").unwrap();
        tree.close().unwrap();
        assert!(matches!(
            wait_for_handle(&ping_handle, 5_000).unwrap(),
            HandleWait::Signalled
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawns ping.exe and proves cancellation kills the complete Windows process tree"]
    async fn managed_tree_cancellation_kills_the_descendant() {
        use windows::Win32::System::Threading::PROCESS_SYNCHRONIZE;

        let temporary = tempfile::tempdir().unwrap();
        let pid_file = temporary.path().join("cancel-ping.pid");
        let spec = nested_test_spec("managed_tree_descendant_helper")
            .environment_override("VIBE_CS_MANAGED_DESCENDANT_HELPER", "1")
            .unwrap()
            .environment_override("VIBE_CS_MANAGED_PID_FILE", pid_file.as_os_str())
            .unwrap();
        let system_root = std::env::var_os("SYSTEMROOT").unwrap();
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let cancellation = ProcessCancellation::default();
        let tree = ManagedProcessTree::spawn(&spec, &cancellation).unwrap();
        let ping_process_id = tree
            .wait_for_unique_process(&ping, Duration::from_secs(10), &cancellation)
            .await
            .unwrap();
        // SAFETY: the PID came from the bounded job membership query and access is read/wait only.
        let ping_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                ping_process_id,
            )
        }
        .unwrap();
        let ping_handle = OwnedWin32Handle::new(ping_handle, "opening cancellation ping").unwrap();

        cancellation.cancel();
        assert!(matches!(
            tree.wait(&cancellation).await,
            Err(PlatformError::Cancelled {
                process_id: Some(process_id)
            }) if process_id == tree.primary_process_id()
        ));
        assert!(matches!(
            wait_for_handle(&ping_handle, 5_000).unwrap(),
            HandleWait::Signalled
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "spawns ping.exe and proves Drop kills the complete Windows process tree"]
    async fn managed_tree_drop_kills_the_descendant() {
        use windows::Win32::System::Threading::PROCESS_SYNCHRONIZE;

        let temporary = tempfile::tempdir().unwrap();
        let pid_file = temporary.path().join("drop-ping.pid");
        let spec = nested_test_spec("managed_tree_descendant_helper")
            .environment_override("VIBE_CS_MANAGED_DESCENDANT_HELPER", "1")
            .unwrap()
            .environment_override("VIBE_CS_MANAGED_PID_FILE", pid_file.as_os_str())
            .unwrap();
        let system_root = std::env::var_os("SYSTEMROOT").unwrap();
        let ping = PathBuf::from(system_root).join("System32").join("PING.EXE");
        let cancellation = ProcessCancellation::default();
        let tree = ManagedProcessTree::spawn(&spec, &cancellation).unwrap();
        let ping_process_id = tree
            .wait_for_unique_process(&ping, Duration::from_secs(10), &cancellation)
            .await
            .unwrap();
        // SAFETY: the PID came from the bounded job membership query and access is read/wait only.
        let ping_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                ping_process_id,
            )
        }
        .unwrap();
        let ping_handle = OwnedWin32Handle::new(ping_handle, "opening drop-test ping").unwrap();

        drop(tree);
        assert!(matches!(
            wait_for_handle(&ping_handle, 5_000).unwrap(),
            HandleWait::Signalled
        ));
    }

    #[cfg(windows)]
    fn nested_test_spec(helper: &str) -> ProcessTreeSpec {
        ProcessTreeSpec::new(std::env::current_exe().unwrap())
            .unwrap()
            .arg("--ignored")
            .unwrap()
            .arg("--exact")
            .unwrap()
            .arg(format!("managed_process_tree::tests::{helper}"))
            .unwrap()
            .arg("--nocapture")
            .unwrap()
    }
}
