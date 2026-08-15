use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use tempfile::TempDir;
use vibe_cs_hlae::{
    HlaeDiscoverySource, HlaeError, HlaeInstallation, HlaeLaunchProfile, LaunchResolution,
    build_hlae_custom_loader_invocation, build_hlae_launch_profile,
};

struct LaunchFixture {
    _root: TempDir,
    hlae: PathBuf,
    hook: PathBuf,
    game: PathBuf,
    steam: PathBuf,
    moviemaking_config: PathBuf,
    profile: HlaeLaunchProfile,
}

fn launch_fixture() -> LaunchFixture {
    let root = tempfile::tempdir().unwrap();
    let hlae = root.path().join("HLAE.exe");
    let hook = root.path().join("x64/AfxHookSource2.dll");
    let game = root.path().join("game/bin/win64/cs2.exe");
    let steam = root.path().join("Steam/steam.exe");
    let moviemaking_config = root.path().join("mmcfg");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::create_dir_all(game.parent().unwrap()).unwrap();
    fs::create_dir_all(steam.parent().unwrap()).unwrap();
    fs::create_dir_all(&moviemaking_config).unwrap();
    for path in [&hlae, &hook, &game, &steam] {
        fs::write(path, b"stub").unwrap();
    }
    let installation = HlaeInstallation {
        root: root.path().to_path_buf(),
        executable: hlae.clone(),
        source2_hook: hook.clone(),
        source: HlaeDiscoverySource::Managed,
    };
    let profile = build_hlae_launch_profile(
        &installation,
        &game,
        &steam,
        &moviemaking_config,
        LaunchResolution {
            width: 1920,
            height: 1080,
        },
    )
    .unwrap();

    LaunchFixture {
        _root: root,
        hlae,
        hook,
        game,
        steam,
        moviemaking_config,
        profile,
    }
}

#[test]
fn builds_the_documented_custom_loader_argv_without_a_shell() {
    let fixture = launch_fixture();
    let invocation = build_hlae_custom_loader_invocation(&fixture.profile).unwrap();

    assert_eq!(invocation.executable(), fixture.hlae);
    assert_eq!(
        invocation.arguments(),
        [
            OsString::from("-customLoader"),
            OsString::from("-noGui"),
            OsString::from("-noConfig"),
            OsString::from("-autoStart"),
            OsString::from("-hookDllPath"),
            fixture.hook.into_os_string(),
            OsString::from("-programPath"),
            fixture.game.into_os_string(),
            OsString::from("-cmdLine"),
            OsString::from(
                "-steam -insecure +sv_lan 1 -console -sw -w 1920 -h 1080 -afxDisableSteamStorage",
            ),
            OsString::from("-addEnv"),
            OsString::from("SteamAppId=730"),
            OsString::from("-addEnv"),
            OsString::from("SteamClientLaunch=1"),
            OsString::from("-addEnv"),
            OsString::from("SteamGameId=730"),
            OsString::from("-addEnv"),
            OsString::from("SteamOverlayGameId=730"),
            OsString::from("-addEnv"),
            OsString::from(format!(
                "SteamPath={}",
                fixture.steam.parent().unwrap().display()
            )),
            OsString::from("-addEnv"),
            OsString::from(format!(
                "USRLOCALCSGO={}",
                fixture.moviemaking_config.display()
            )),
        ]
    );
}

#[cfg(windows)]
#[test]
fn launch_profile_never_exposes_a_verbatim_usr_local_csgo_search_path() {
    let fixture = launch_fixture();
    let installation = HlaeInstallation {
        root: fixture.hlae.parent().unwrap().to_path_buf(),
        executable: fixture.hlae.clone(),
        source2_hook: fixture.hook.clone(),
        source: HlaeDiscoverySource::Managed,
    };
    let verbatim_root = PathBuf::from(format!(r"\\?\{}", fixture.moviemaking_config.display()));

    let profile = build_hlae_launch_profile(
        &installation,
        &fixture.game,
        &fixture.steam,
        &verbatim_root,
        LaunchResolution {
            width: 1280,
            height: 720,
        },
    )
    .expect("launch profile");

    let value = profile
        .environment
        .get("USRLOCALCSGO")
        .expect("USRLOCALCSGO");
    assert!(
        !value.starts_with(r"\\?\"),
        "unexpected verbatim path: {value}"
    );
    assert_eq!(Path::new(value), fixture.moviemaking_config);
}

#[test]
fn refuses_a_missing_or_non_steam_executable() {
    let fixture = launch_fixture();
    let installation = HlaeInstallation {
        root: fixture.hlae.parent().unwrap().to_path_buf(),
        executable: fixture.hlae,
        source2_hook: fixture.hook,
        source: HlaeDiscoverySource::Managed,
    };
    let wrong = fixture.steam.with_file_name("not-steam.exe");
    fs::write(&wrong, b"stub").unwrap();

    assert!(
        build_hlae_launch_profile(
            &installation,
            &fixture.game,
            &wrong,
            &fixture.moviemaking_config,
            LaunchResolution {
                width: 1920,
                height: 1080,
            },
        )
        .is_err()
    );
}

#[test]
fn refuses_a_profile_that_drops_mandatory_insecure_mode() {
    let mut fixture = launch_fixture();
    fixture
        .profile
        .arguments
        .retain(|value| value != "-insecure");

    assert!(build_hlae_custom_loader_invocation(&fixture.profile).is_err());
}

#[test]
fn refuses_arbitrary_game_arguments() {
    let mut fixture = launch_fixture();
    fixture.profile.arguments[4] = "+exec unreviewed.cfg".to_owned();

    assert!(build_hlae_custom_loader_invocation(&fixture.profile).is_err());
}

#[test]
fn refuses_control_characters_in_custom_loader_values() {
    let mut fixture = launch_fixture();
    fixture.profile.environment.insert(
        "USRLOCALCSGO".to_owned(),
        format!("{}\nUNREVIEWED=value", fixture.moviemaking_config.display()),
    );

    assert!(matches!(
        build_hlae_custom_loader_invocation(&fixture.profile),
        Err(HlaeError::UnsafePath {
            field: "moviemakingConfigRoot",
            ..
        })
    ));
}

#[test]
fn refuses_a_drifted_steam_environment() {
    let mut fixture = launch_fixture();
    let unrelated = fixture
        .steam
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("other");
    fs::create_dir(&unrelated).unwrap();
    fixture.profile.environment.insert(
        "SteamPath".to_owned(),
        unrelated.to_string_lossy().into_owned(),
    );

    assert!(build_hlae_custom_loader_invocation(&fixture.profile).is_err());
}
