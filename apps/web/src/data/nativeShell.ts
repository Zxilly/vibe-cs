/**
 * data layer — the seam onto the native desktop shell (spec §2.1 rule 6).
 *
 * `shared/desktop/dialog.ts` holds eight real capabilities — file and directory
 * pickers, a save dialog, a byte writer, 「在资源管理器中定位」, an opener and an
 * external-URL guard — and `shared/desktop/client.ts` holds `desktopMediaUrl`,
 * which turns a service path into the `vibe-cs-media:` URL the Tauri CSP lets a
 * `<video>` or `<audio>` element load. `pages/**` may not import either
 * (`scripts/check-web-layers.mjs` rule 6), so this file is the door, exactly as
 * `data/serviceAction.tsx` is the door onto the health probe.
 *
 * ## Why a context and not nine exported functions
 *
 * Two reasons, and the second is the one that matters.
 *
 * **Tests.** Every capability below is an `await import('@tauri-apps/plugin-…')`
 * behind an `isDesktopShell()` guard. Under vitest that guard is `false`, so a
 * page that called them directly would silently do nothing and a test would
 * have to `vi.mock` a plugin module per file to observe anything at all. With a
 * context, a test mounts `NativeShellProvider` with a plain object of spies —
 * the same arrangement `DesktopClientProvider` already uses, and for the same
 * reason.
 *
 * **`available` is a rendered fact, not a silent branch.** 「不隐藏、不静默失败」
 * applies here as much as to a service-backed action: outside the desktop shell
 * 「导入音乐」 and 「定位文件」 cannot work, and the honest answer is a disabled
 * button with a written reason. `useNativeShellAction()` produces that pair, so
 * no page writes the sentence twice. A capability that is called anyway
 * resolves to `null` / `false` / `[]` rather than throwing — a rejected promise
 * from a picker the user cannot reach is noise, not information.
 *
 * ## What this layer must not become
 *
 * No business decisions live here. Which filters a picker offers, what a chosen
 * path is then imported as, whether an export needs a directory — all of that
 * is the page's. This file answers two questions only: *can the shell do this*,
 * and *what is the function called*.
 *
 * ## `mediaSrc`, and why it can return `null`
 *
 * `desktopMediaUrl` **throws** for a path outside `/api/…`, and the Rust side
 * (`apps/desktop/src-tauri/src/bridge.rs`, `validate_media_path`) additionally
 * accepts only a closed list: `/recorded-clips/{uuid}/stream`,
 * `/media/assets/{uuid}/stream`, `/media/assets/{uuid}/proxy/stream`,
 * `/players/{steamId}/avatar`, `/maps/{map}/radar` and two others. A page
 * building a `src` should not have to hold a try/catch, so a rejected path
 * comes back as `null` and the page renders its 「预览不可用」 placeholder. This
 * is **the only entry point for a media URL on these two pages** — a `src` built
 * by string concatenation would work in the dev server and fail in the shipped
 * app, which is the worst possible place to find out.
 */

import { t } from '@lingui/core/macro';
import { createContext, createElement, use, useCallback, useMemo, type ReactNode } from 'react';

import { toast } from '../design/feedback';
import { desktopMediaUrl } from '../shared/desktop/client';
import {
  chooseLocalDirectories,
  chooseLocalFile,
  chooseLocalFiles,
  chooseLocalSavePath,
  isDesktopShell,
  openExternalHttpsUrl,
  openLocalDirectory,
  revealLocalPath,
  saveLocalBytes,
  readLocalBytes,
  writeLocalBytes,
  type LocalDialogFilter,
} from '../shared/desktop/dialog';

export type { LocalDialogFilter };

export interface ChooseFileOptions {
  /** The OS dialog's title. A page decides the wording; this layer does not. */
  readonly title: string;
  readonly filters?: readonly LocalDialogFilter[] | undefined;
}

export interface ChooseDirectoryOptions {
  readonly title: string;
  readonly multiple?: boolean | undefined;
}

export interface SavePathOptions {
  readonly title: string;
  readonly defaultFileName: string;
  readonly filters: readonly LocalDialogFilter[];
}

export interface SaveBytesOptions extends SavePathOptions {
  readonly bytes: Uint8Array;
}

/**
 * Everything the desktop shell can do for a page, in one injectable object.
 *
 * Every method is safe to call when `available` is `false`; each one then
 * resolves to the "nothing happened" value of its own type. Pages are still
 * expected to disable the affordance first — see `useNativeShellAction`.
 */
export interface NativeShell {
  /** `false` in a browser dev server and in every test that does not say
   *  otherwise. The single fact every disabled reason on these pages derives
   *  from. */
  readonly available: boolean;
  /** One file. `null` when cancelled *or* unavailable — a page that needs to
   *  tell those apart should have checked `available` first. */
  readonly chooseFile: (options: ChooseFileOptions) => Promise<string | null>;
  readonly chooseFiles: (options: ChooseFileOptions) => Promise<string[]>;
  readonly chooseDirectories: (options: ChooseDirectoryOptions) => Promise<string[]>;
  /** Where to write, without writing. 「导出到…」 asks this before it starts a
   *  job it cannot undo. */
  readonly chooseSavePath: (options: SavePathOptions) => Promise<string | null>;
  /** Pick a path and write in one step; resolves to the path written, or `null`
   *  when the user cancelled. */
  readonly saveBytes: (options: SaveBytesOptions) => Promise<string | null>;
  /** Write to a path already chosen. Rejects when there is no shell — unlike
   *  the pickers, this one has no meaningful "did nothing" answer, and
   *  `shared/desktop/dialog` already throws. */
  readonly writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  /** 「在资源管理器中定位」. `false` when there is no shell or no path. */
  readonly reveal: (path: string) => Promise<boolean>;
  readonly openDirectory: (path: string) => Promise<boolean>;
  /** HTTPS only, and never a private address — the guard lives in
   *  `shared/desktop/dialog`, not here. */
  readonly openExternalUrl: (url: string) => Promise<boolean>;
  /**
   * A service path (`/api/media/assets/{id}/stream`) as a URL the shipped app
   * is allowed to load. `null` when the path is outside the bridge's whitelist
   * or there is no shell to serve it.
   */
  readonly mediaSrc: (path: string) => string | null;
}

/* ── the production implementation ───────────────────────────────────────── */

/**
 * Built once at module scope rather than per render: it closes over nothing,
 * and a new object identity every render would defeat the `useMemo` in every
 * consumer that depends on it.
 */
export const desktopNativeShell: NativeShell = {
  get available() {
    /* A getter, not a captured boolean: `isDesktopShell()` reads
       `window.location` and `__TAURI_INTERNALS__`, neither of which exists when
       this module is first evaluated during SSR-style static rendering. */
    return isDesktopShell();
  },
  chooseFile: (options) =>
    chooseLocalFile({
      title: options.title,
      ...(options.filters ? { filters: [...options.filters] } : {}),
    }),
  chooseFiles: (options) =>
    chooseLocalFiles({
      title: options.title,
      ...(options.filters ? { filters: [...options.filters] } : {}),
    }),
  chooseDirectories: (options) =>
    chooseLocalDirectories({
      title: options.title,
      ...(options.multiple === undefined ? {} : { multiple: options.multiple }),
    }),
  chooseSavePath: (options) =>
    chooseLocalSavePath({
      title: options.title,
      defaultFileName: options.defaultFileName,
      filters: [...options.filters],
    }),
  saveBytes: (options) =>
    saveLocalBytes({
      title: options.title,
      defaultFileName: options.defaultFileName,
      filters: [...options.filters],
      bytes: options.bytes,
    }),
  writeBytes: (path, bytes) => writeLocalBytes(path, bytes),
  readBytes: (path) => readLocalBytes(path),
  reveal: (path) => revealLocalPath(path),
  openDirectory: (path) => openLocalDirectory(path),
  openExternalUrl: (url) => openExternalHttpsUrl(url),
  mediaSrc: (path) => {
    if (!isDesktopShell()) return null;
    try {
      return desktopMediaUrl(path);
    } catch {
      /* `desktopMediaUrl` throws `INVALID_MEDIA_URL` for anything outside
         `/api/…`. A caller asking for a src wants a src or nothing. */
      return null;
    }
  },
};

/**
 * The shell as it behaves with no desktop under it. Exported so a test that
 * wants the *disabled* branch does not have to hand-build nine no-ops, and so
 * the browser dev server has something honest to render against.
 */
export const unavailableNativeShell: NativeShell = {
  available: false,
  chooseFile: () => Promise.resolve(null),
  chooseFiles: () => Promise.resolve([]),
  chooseDirectories: () => Promise.resolve([]),
  chooseSavePath: () => Promise.resolve(null),
  saveBytes: () => Promise.resolve(null),
  writeBytes: () => Promise.reject(new Error('A desktop save path is required.')),
  readBytes: () => Promise.reject(new Error('A desktop file path is required.')),
  reveal: () => Promise.resolve(false),
  openDirectory: () => Promise.resolve(false),
  openExternalUrl: () => Promise.resolve(false),
  mediaSrc: () => null,
};

/* ── the seam ────────────────────────────────────────────────────────────── */

const NativeShellContext = createContext<NativeShell>(desktopNativeShell);

export interface NativeShellProviderProps {
  readonly shell: NativeShell;
  readonly children: ReactNode;
}

/**
 * Overrides the shell for the tree below. Only tests and stories mount it — the
 * default is already correct in the app, exactly as `DesktopClientProvider`'s
 * is, so there is no "provider missing" throw here.
 *
 * Written with `createElement` rather than JSX so this module stays a `.ts`
 * file: everything else in it is plain TypeScript, and the one element it
 * produces is not worth changing the extension for.
 */
export function NativeShellProvider({ shell, children }: NativeShellProviderProps) {
  return createElement(NativeShellContext.Provider, { value: shell }, children);
}

export function useNativeShell(): NativeShell {
  return use(NativeShellContext);
}

/* ── 「禁用并写明原因」 ───────────────────────────────────────────────────── */

/**
 * Spreadable onto `design/primitives/Button`, the same pair
 * `ServiceActionState.buttonProps` produces. `disabledReason` is *absent*
 * rather than `undefined` when the shell is there, because the workspace
 * compiles with `exactOptionalPropertyTypes`.
 */
export interface NativeShellActionProps {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export interface NativeShellActionState {
  readonly available: boolean;
  readonly buttonProps: NativeShellActionProps;
}

/**
 * 「这个动作需要桌面应用」, derived once.
 *
 *   const shellAction = useNativeShellAction();
 *   <Button {...shellAction.buttonProps} onClick={…}>…</Button>
 *
 * Deliberately *not* merged with `useServiceAction()`: they block for different
 * reasons and recover at different times — the service can come back without a
 * reload, the browser cannot become a desktop app — so a page that shows one
 * sentence for both would be telling the user to wait for something that is
 * never going to happen.
 */
export function useNativeShellAction(): NativeShellActionState {
  const { available } = useNativeShell();
  const reason = t`这个动作需要桌面应用，浏览器里无法访问本机文件`;

  return useMemo(
    () =>
      available
        ? { available: true, buttonProps: { disabled: false } }
        : { available: false, buttonProps: { disabled: true, disabledReason: reason } },
    [available, reason],
  );
}

/* ── 「不隐藏、不静默失败」 ───────────────────────────────────────────────── */

/**
 * 「打开目录」 / 「定位文件」, and the answer said out loud.
 *
 * `openDirectory` and `reveal` return `false` when the shell refused — no
 * folder, a path outside the bridge's whitelist, a browser rather than the
 * desktop app — and every one of the five call sites dropped that boolean.
 * Clicking 「打开目录」 did nothing at all and the product said nothing about
 * it, which is the exact case 「不隐藏、不静默失败」 is about.
 *
 * A toast rather than an `Alert`: there is nothing to decide. The folder opened
 * or it did not, the retry is the same click, and a box that stays on the page
 * until dismissed would outlive the question it answers. The split is stated in
 * `design/feedback/Toast`.
 */
export function useOpenDirectory(): (path: string) => void {
  const shell = useNativeShell();

  return useCallback(
    (path: string) => {
      void shell
        .openDirectory(path)
        .then((opened) => {
          if (!opened) toast.error(t`没能打开这个目录`, { description: path });
        })
        .catch(() => {
          toast.error(t`没能打开这个目录`, { description: path });
        });
    },
    [shell],
  );
}

export function useRevealPath(): (path: string) => void {
  const shell = useNativeShell();

  return useCallback(
    (path: string) => {
      void shell
        .reveal(path)
        .then((revealed) => {
          if (!revealed) toast.error(t`没能定位这个文件`, { description: path });
        })
        .catch(() => {
          toast.error(t`没能定位这个文件`, { description: path });
        });
    },
    [shell],
  );
}
