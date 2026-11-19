fn main() {
  // A company build can carry its server address (lib.rs, BUILT_IN).
  println!("cargo:rerun-if-env-changed=WORKSPACE_URL");
  tauri_build::build()
}
