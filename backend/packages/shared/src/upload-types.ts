/**
 * What people may upload (task and page attachments, Drive, chat): any kind of file except the ones that run on
 * a computer when opened. A deny list, not an allow list: an office has more file kinds than a list can name
 * (design files, CAD, archives, HTML exports, source code), and a refused upload sends people to another tool.
 *
 * Two rules keep "any file" safe:
 *  - programs, installers and scripts the operating system runs on a double click are refused, by extension
 *    (what the OS goes by) and by content type;
 *  - nothing a browser could execute is ever shown inline: HTML, SVG, XML and scripts are stored and handed back
 *    as a download (`inlineSafe`), so a page somebody uploaded never runs with the app's cookies.
 */

/** Extensions the operating system runs or installs when the file is opened. */
export const BLOCKED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows programs, installers and shell scripts
  ...["exe", "msi", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle", "com", "scr", "pif", "cpl", "dll", "sys", "drv", "ocx"],
  ...["bat", "cmd", "ps1", "ps1xml", "ps2", "psm1", "psd1", "psc1", "vb", "vbs", "vbe", "js", "jse", "ws", "wsf", "wsc", "wsh", "hta"],
  ...["lnk", "url", "scf", "inf", "reg", "gadget", "application", "appref-ms", "msc", "jar", "jnlp", "chm", "hlp", "xll", "wll"],
  // macOS
  ...["app", "dmg", "pkg", "mpkg", "command", "action", "workflow", "scpt", "scptd", "applescript", "terminal", "osx", "kext"],
  // Linux, Unix and phones
  ...["sh", "bash", "zsh", "csh", "ksh", "fish", "run", "bin", "elf", "out", "so", "deb", "rpm", "appimage", "snap", "flatpak", "desktop"],
  ...["apk", "xapk", "aab", "ipa"],
]);

/** Content types of the same things, for a program uploaded under an innocent name. */
export const BLOCKED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-ms-installer",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-csh",
  "application/x-bat",
  "application/x-ms-shortcut",
  "application/hta",
  "application/java-archive",
  "application/x-java-archive",
  "application/x-java-jnlp-file",
  "application/x-apple-diskimage",
  "application/vnd.apple.installer+xml",
  "application/vnd.android.package-archive",
  "application/vnd.debian.binary-package",
  "application/x-debian-package",
  "application/x-rpm",
  "application/x-redhat-package-manager",
  "application/x-ms-application",
  "application/vnd.ms-htmlhelp",
]);

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

/** A content type without its parameters, lower case ("text/html; charset=utf-8" → "text/html"). */
export const baseContentType = (contentType: string) => contentType.split(";")[0]!.trim().toLowerCase();

/** Every extension of a name, last first ("report.pdf.exe" → ["exe", "pdf"]); a trailing dot or space is Windows' way to hide one. */
function extensions(name: string): string[] {
  const parts = name
    .toLowerCase()
    .replace(/[\s.]+$/, "")
    .split(".");
  return parts.slice(1).reverse();
}

/**
 * Why this upload is refused, or null when it may be stored (the web app looks for "type … not allowed" in it). Only the last extension decides ("build.sh.txt" is a
 * text file), but a name ending in a blocked one is refused whatever content type the browser claimed.
 */
export function uploadRefusal(name: string, contentType: string): string | null {
  const type = baseContentType(contentType);
  if (!MIME.test(type)) return `content type ${contentType.slice(0, 80)} not allowed: it is not a valid type`;
  const ext = extensions(name)[0];
  if (ext && BLOCKED_UPLOAD_EXTENSIONS.has(ext)) return `file type .${ext} not allowed: programs and scripts cannot be uploaded`;
  if (BLOCKED_UPLOAD_TYPES.has(type)) return `content type ${type} not allowed: programs and scripts cannot be uploaded`;
  return null;
}

/**
 * Whether a stored file may be shown inside a page (Content-Disposition: inline): pictures, PDF, sound, video and
 * plain text. Everything else is a download, above all what a browser would run: HTML, SVG, XML, scripts.
 */
export function inlineSafe(contentType: string): boolean {
  const type = baseContentType(contentType);
  if (type === "image/svg+xml") return false;
  return /^(image|audio|video)\//.test(type) || type === "application/pdf" || type === "text/plain";
}
