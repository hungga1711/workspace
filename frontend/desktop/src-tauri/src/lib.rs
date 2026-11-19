//! The desktop app is a window onto the company's own workspace server: it loads the same web app the browser does,
//! so there is no second UI to keep in step. The only page of its own is the bundled connect page (../connect), shown
//! until a server address is saved, and only when the address did not come another way: a `workspace://` link from
//! the web app's "Open in app", a company build with the address built in, or a managed install. Native parts: notifications, downloads, links to other sites in the browser,
//! one instance, remembered window size.

use std::{
  fs,
  path::PathBuf,
  sync::atomic::{AtomicUsize, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{
  ipc::CapabilityBuilder,
  menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
  webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse},
  AppHandle, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
/// The notification plugin's stand-in for `Notification` has no close(); the web app closes a call's notification
/// when the ringing stops. Runs after the plugin's script.
const NOTIFICATION_CLOSE: &str =
  "if (window.Notification && !Notification.prototype.close) Notification.prototype.close = function () {};";
static WINDOWS: AtomicUsize = AtomicUsize::new(0);
/// The company's address, when its own build carries it: `WORKSPACE_URL=https://work.company.com pnpm build`.
const BUILT_IN: Option<&str> = option_env!("WORKSPACE_URL");

#[derive(Serialize, Deserialize)]
struct Saved {
  url: String,
}

fn saved_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|d| d.join("server.json"))
}

fn saved_server<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
  let text = fs::read_to_string(saved_file(app)?).ok()?;
  Url::parse(&serde_json::from_str::<Saved>(&text).ok()?.url).ok()
}

fn save_server<R: Runtime>(app: &AppHandle<R>, url: Option<&Url>) -> Result<(), String> {
  let file = saved_file(app).ok_or("no config directory")?;
  match url {
    Some(u) => {
      fs::create_dir_all(file.parent().ok_or("no config directory")?).map_err(|e| e.to_string())?;
      let json = serde_json::to_string(&Saved { url: u.to_string() }).map_err(|e| e.to_string())?;
      fs::write(file, json).map_err(|e| e.to_string())
    }
    None => {
      let _ = fs::remove_file(file);
      Ok(())
    }
  }
}

/// The server's pages may use the notification plugin (it stands in for the browser's `Notification`), nothing else.
/// The address is the company's own, so the permission is granted at run time rather than in capabilities/.
fn trust_server<R: Runtime>(app: &AppHandle<R>, server: &Url) {
  let origin = server.origin().ascii_serialization();
  let _ = app.add_capability(
    CapabilityBuilder::new(format!("server:{origin}"))
      .remote(format!("{origin}/*"))
      .windows(["*"])
      .permission("notification:allow-is-permission-granted")
      .permission("notification:allow-request-permission")
      .permission("notification:allow-notify"),
  );
}

/// The bundled connect page. `last` pre-fills the address when changing servers; `server` opens that server (and
/// `page` on it) once it answers, showing "no internet connection" until then rather than a blank window.
fn connect_page(params: &[(&str, &str)]) -> Url {
  let base = if cfg!(windows) {
    "http://tauri.localhost/index.html"
  } else {
    "tauri://localhost/index.html"
  };
  let mut url = Url::parse(base).expect("static url");
  if !params.is_empty() {
    url.query_pairs_mut().extend_pairs(params);
  }
  url
}

fn opening(server: &Url, page: Option<&Url>) -> Url {
  match page {
    Some(page) => connect_page(&[("server", server.as_str()), ("page", page.as_str())]),
    None => connect_page(&[("server", server.as_str())]),
  }
}

fn same_site<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
  match url.scheme() {
    "about" | "blob" | "data" => true,
    "http" | "https" => saved_server(app).is_some_and(|s| s.origin() == url.origin()),
    _ => false,
  }
}

/// Every window (the main one and those the app opens with target=_blank, e.g. a meeting) behaves the same.
fn window<R: Runtime>(
  app: &AppHandle<R>,
  label: &str,
  url: WebviewUrl,
  features: Option<NewWindowFeatures>,
) -> tauri::Result<WebviewWindow<R>> {
  let handle = app.clone();
  let mut b = WebviewWindowBuilder::new(app, label, url)
    .title("workspace")
    .inner_size(1280.0, 820.0)
    .min_inner_size(400.0, 500.0)
    .initialization_script(NOTIFICATION_CLOSE)
    .on_document_title_changed(|w, title| {
      let _ = w.set_title(&title);
    })
    .on_new_window(move |url, features| {
      if !same_site(&handle, &url) {
        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
        return NewWindowResponse::Deny;
      }
      let label = format!("w{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
      // WebKit loads the request into the window it is handed, so it starts blank.
      match window(
        &handle,
        &label,
        WebviewUrl::External("about:blank".parse().expect("static url")),
        Some(features),
      ) {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
      }
    })
    .on_download(download);
  if let Some(f) = features {
    b = b.window_features(f);
  }
  b.build()
}

/// Files go to Downloads (never over an existing file) and are shown in the file manager when done.
fn download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
  match event {
    DownloadEvent::Requested { destination, .. } => {
      if let Ok(dir) = webview.app_handle().path().download_dir() {
        let name = destination
          .file_name()
          .map(|n| n.to_string_lossy().into_owned())
          .unwrap_or_else(|| "download".into());
        let (stem, ext) = match name.rsplit_once('.') {
          Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
          _ => (name.clone(), String::new()),
        };
        let mut path = dir.join(&name);
        let mut n = 1;
        while path.exists() {
          path = dir.join(format!("{stem} ({n}){ext}"));
          n += 1;
        }
        *destination = path;
      }
    }
    DownloadEvent::Finished {
      path: Some(path),
      success: true,
      ..
    } => {
      let _ = webview.app_handle().opener().reveal_item_in_dir(path);
    }
    _ => {}
  }
  true
}

/// `workspace://open?server=https://work.company.com&path=/app/chat`, from the web app's "Open in app". The browser
/// asks the person before it starts the app, so a first address is taken as is; a different server than the saved one
/// shows the connect page with it filled in, and the person confirms it there.
fn open_link<R: Runtime>(app: &AppHandle<R>, link: &Url) {
  let param = |name: &str| link.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
  let Some(server) = param("server")
    .and_then(|s| Url::parse(&s).ok())
    .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
    .and_then(|u| Url::parse(&u.origin().ascii_serialization()).ok())
  else {
    return;
  };
  let Some(main) = app.get_webview_window(MAIN) else {
    return;
  };
  let page = param("path")
    .filter(|p| p.starts_with('/') && !p.starts_with("//"))
    .and_then(|p| server.join(&p).ok());
  // The connect page saves the address (connect) once the server answers.
  let _ = match saved_server(app) {
    Some(saved) if saved.origin() != server.origin() => main.navigate(connect_page(&[("last", server.as_str())])),
    _ => main.navigate(opening(&server, page.as_ref())),
  };
  let _ = main.unminimize();
  let _ = main.set_focus();
}

/// Called by the connect page once the address answered; `page` is where to go on it (a page of the same server).
#[tauri::command]
fn connect(app: AppHandle, window: WebviewWindow, url: String, page: Option<String>) -> Result<(), String> {
  let url = Url::parse(&url).map_err(|e| e.to_string())?;
  if !matches!(url.scheme(), "http" | "https") {
    return Err("http or https only".into());
  }
  save_server(&app, Some(&url))?;
  trust_server(&app, &url);
  let target = page
    .and_then(|p| Url::parse(&p).ok())
    .filter(|p| p.origin() == url.origin())
    .unwrap_or(url);
  window.navigate(target).map_err(|e| e.to_string())
}

fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
  let go = Submenu::with_items(
    app,
    "Go",
    true,
    &[
      &MenuItem::with_id(app, "back", "Back", true, Some("CmdOrCtrl+["))?,
      &MenuItem::with_id(app, "forward", "Forward", true, Some("CmdOrCtrl+]"))?,
      &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "server", "Change server…", true, None::<&str>)?,
    ],
  )?;
  // macOS keeps its standard menus (app, Edit for copy/paste, Window); elsewhere the Go menu is the menu bar.
  let menu = if cfg!(target_os = "macos") {
    Menu::default(app)?
  } else {
    Menu::new(app)?
  };
  menu.append(&go)?;
  Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| {
      if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.set_focus();
      }
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_notification::init())
    // Links with target=_blank go through on_new_window like window.open; the plugin's own click handler would need
    // IPC rights the server's pages do not have.
    .plugin(
      tauri_plugin_opener::Builder::new()
        .open_js_links_on_click(false)
        .build(),
    )
    .invoke_handler(tauri::generate_handler![connect])
    .menu(menu)
    .on_menu_event(|app, event| {
      let Some(w) = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN))
      else {
        return;
      };
      let _ = match event.id().as_ref() {
        "back" => w.eval("history.back()"),
        "forward" => w.eval("history.forward()"),
        // Offline, a reload would leave a blank window; the web app's strip already says why.
        "reload" => w.eval("if (navigator.onLine !== false) location.reload()"),
        "server" => {
          let last = saved_server(app);
          let _ = save_server(app, None);
          match app.get_webview_window(MAIN) {
            Some(main) => main.navigate(match &last {
              Some(last) => connect_page(&[("last", last.as_str())]),
              None => connect_page(&[]),
            }),
            None => Ok(()),
          }
        }
        _ => Ok(()),
      };
    })
    .setup(|app| {
      let handle = app.handle();
      // A managed install (MDM, Intune) or the company's own build sets the address, so nobody types it.
      let preset = std::env::var("WORKSPACE_URL")
        .ok()
        .or(BUILT_IN.map(String::from))
        .and_then(|u| Url::parse(&u).ok());
      if let (None, Some(url)) = (saved_server(handle), &preset) {
        let _ = save_server(handle, Some(url));
      }
      // Through the connect page, which goes on to the server once it answers.
      let start = match saved_server(handle).or(preset) {
        Some(server) => WebviewUrl::CustomProtocol(opening(&server, None)),
        None => WebviewUrl::App("index.html".into()),
      };
      window(handle, MAIN, start, None)?;
      // Installers register the scheme; this covers a portable or dev copy on Windows and Linux.
      #[cfg(any(windows, target_os = "linux"))]
      let _ = app.deep_link().register_all();
      let links = handle.clone();
      app.deep_link().on_open_url(move |event| {
        for link in event.urls() {
          open_link(&links, &link);
        }
      });
      for link in app.deep_link().get_current().ok().flatten().unwrap_or_default() {
        open_link(handle, &link);
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the workspace desktop app");
}
