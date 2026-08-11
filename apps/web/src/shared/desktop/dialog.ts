export type LocalDialogFilter = {
  name: string;
  extensions: string[];
};

export type DesktopLocation = {
  protocol: string;
  hostname: string;
  hasTauriInternals: boolean;
};

export function isDesktopLocation(location: DesktopLocation): boolean {
  return location.hasTauriInternals
    || location.protocol === 'tauri:'
    || location.hostname.toLocaleLowerCase() === 'tauri.localhost';
}

export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return isDesktopLocation({
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    hasTauriInternals: '__TAURI_INTERNALS__' in window,
  });
}

export async function chooseLocalFile(options: {
  title: string;
  filters?: LocalDialogFilter[];
}): Promise<string | null> {
  if (!isDesktopShell()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: options.title,
    multiple: false,
    directory: false,
    ...(options.filters ? { filters: options.filters } : {}),
  });
  return typeof selected === 'string' ? selected : null;
}

export async function chooseLocalFiles(options: {
  title: string;
  filters?: LocalDialogFilter[];
}): Promise<string[]> {
  if (!isDesktopShell()) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: options.title,
    multiple: true,
    directory: false,
    ...(options.filters ? { filters: options.filters } : {}),
  });
  if (Array.isArray(selected)) return selected;
  return typeof selected === 'string' ? [selected] : [];
}

export async function chooseLocalDirectories(options: {
  title: string;
  multiple?: boolean;
}): Promise<string[]> {
  if (!isDesktopShell()) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: options.title,
    multiple: options.multiple ?? true,
    directory: true,
    recursive: true,
  });
  if (Array.isArray(selected)) return selected;
  return typeof selected === 'string' ? [selected] : [];
}

/** Reveals a local item using the desktop shell without exposing a command surface. */
export async function revealLocalPath(path: string): Promise<boolean> {
  if (!isDesktopShell() || !path.trim()) return false;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
  return true;
}

/** Opens a service-owned directory only inside the desktop shell. */
export async function openLocalDirectory(path: string): Promise<boolean> {
  if (!isDesktopShell() || !path.trim()) return false;
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(path);
  return true;
}

/** Opens an externally supplied download page after enforcing a narrow HTTPS boundary. */
export async function openExternalHttpsUrl(value: string): Promise<boolean> {
  if (!isSafeExternalHttpsUrl(value)) return false;
  const url = new URL(value);
  if (isDesktopShell()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url.toString());
  } else {
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }
  return true;
}

export function isSafeExternalHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    const privateIpv4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && host !== 'localhost'
      && !host.endsWith('.localhost')
      && host !== '[::1]'
      && !privateIpv4.test(host);
  } catch {
    return false;
  }
}
