// PROTOTYPE — replace with the selected overlay direction and real CS2 window bounds.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "ace-overlay-prototype";

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn toggle_ace_overlay_prototype(
    app: AppHandle,
    variant: String,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .close()
            .map_err(|error| format!("failed to close ACE overlay prototype: {error}"))?;
        return Ok(false);
    }

    let variant = match variant.as_str() {
        "A" | "B" | "C" => variant,
        _ => return Err("ACE overlay prototype variant must be A, B, or C".to_owned()),
    };
    let url = format!("index.html#/prototype/ace-overlay?variant={variant}&mode=overlay");
    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App(url.into()))
        .title("Vibe CS ACE Overlay Prototype")
        .fullscreen(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .build()
        .map_err(|error| format!("failed to open ACE overlay prototype: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("failed to make ACE overlay mouse-transparent: {error}"))?;
    Ok(true)
}
