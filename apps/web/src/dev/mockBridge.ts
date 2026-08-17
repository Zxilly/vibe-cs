/**
 * The browser-only half of `pnpm dev` — Tauri's own IPC mock, wired up.
 *
 * ## Why this exists
 *
 * There are two ways to run this frontend:
 *
 *   `pnpm desktop:dev`  Tauri builds the Rust side, starts Vite through
 *                       `beforeDevCommand`, and loads it in WebView2. Real
 *                       backend, real data, real everything — and a Rust
 *                       compile between every change.
 *   `pnpm dev`          Vite alone, in whatever browser you point at it.
 *                       Instant reload, real devtools, screenshots, an agent
 *                       driving it over CDP.
 *
 * The second one used to be almost useless. `shared/desktop/client.ts` reaches
 * `invoke()` from `@tauri-apps/api/core`, and in a plain browser
 * `window.__TAURI_INTERNALS__` does not exist, so every call rejects. Every
 * page rendered its 「无法连接到本地服务」 card and nothing else. You could check
 * the shell chrome and nothing inside it.
 *
 * `@tauri-apps/api/mocks` is Tauri's documented answer, and it is the answer
 * every Tauri project that tests its frontend uses: `mockIPC` installs a
 * JavaScript `invoke` into `window.__TAURI_INTERNALS__`, so the calls resolve
 * against a handler here instead of against Rust. Nothing in `shared/desktop/`
 * changes — this is the *same seam* the real bridge uses, one layer down.
 *
 * ## Why not a `fetch` mock, or MSW
 *
 * There is no HTTP. The routes in `client.ts` (`/demos/compact`, `/config`, …)
 * are strings inside one `desktop_call` command; the transport is IPC. A
 * service worker would see no traffic at all.
 *
 * ## Why not in the vitest setup instead
 *
 * The test suite already has a better seam for tests — `DesktopClientProvider`
 * takes a typechecked stub object, so a test never goes through IPC at all.
 * This file is for the *running dev server*, where the thing under inspection
 * is the rendered page.
 *
 * ## The guard
 *
 * `__TAURI_INTERNALS__` present means a real WebView, and the mock must never
 * displace a real backend — the check runs before `mockIPC`, which creates that
 * very object. `import.meta.env.DEV` keeps the whole module (and its fixtures)
 * out of `vite build`, because the import in `main.tsx` is inside the same
 * condition.
 *
 * ## Unhandled routes are loud
 *
 * A route with no fixture rejects with a `DesktopCommandFailure`-shaped error,
 * exactly as an unimplemented Rust route would. It reaches the page's own
 * error card *and* prints the missing method and path to the console. The
 * alternative — answering `{}` — renders a blank page and hides the gap, which
 * is the failure mode this whole file exists to end.
 */

import { handleCommand, handleRoute, MockRouteMissing } from './mockBackend';

interface TauriInternals {
  invoke?: unknown;
  runCallback?: (id: number, data: unknown) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __TAURI_INTERNALS__: TauriInternals | undefined;
}

/** What `client.ts` puts on the wire for `desktop_call`. */
interface DesktopCall {
  method: string;
  path: string;
  body?: unknown;
}

function isDesktopCall(value: unknown): value is DesktopCall {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DesktopCall>;
  return typeof candidate.method === 'string' && typeof candidate.path === 'string';
}

/**
 * Pushes one message down a `Channel` the caller handed us.
 *
 * `mockIPC` does not serialize arguments, so `args.onEvent` arrives as the live
 * `Channel` instance rather than as the `"__CHANNEL__:<id>"` string Rust would
 * see. Going through `runCallback` with the `{index, message}` envelope — the
 * shape `Channel`'s own callback parses — exercises the real ordering and
 * cleanup logic instead of poking `onmessage` directly.
 */
export function emitOnChannel(channel: { id: number }, index: number, message: unknown): void {
  globalThis.__TAURI_INTERNALS__?.runCallback?.(channel.id, { index, message });
}

/** Closes a `Channel` so it unregisters its callback, as the Rust side does. */
export function endChannel(channel: { id: number }, index: number): void {
  globalThis.__TAURI_INTERNALS__?.runCallback?.(channel.id, { index, end: true });
}

export async function installMockBridge(): Promise<void> {
  if (globalThis.__TAURI_INTERNALS__?.invoke) return;

  const { mockIPC, mockWindows, mockConvertFileSrc } = await import('@tauri-apps/api/mocks');

  /* `WindowTitleBar` calls `getCurrentWindow()` for minimize / maximize /
     close. Without a label the module throws on import, so the titlebar would
     take the whole shell down before anything below it rendered. */
  mockWindows('main');
  mockConvertFileSrc('windows');

  mockIPC(async (command, args) => {
    if (command === 'desktop_call') {
      const call = (args as { call?: unknown } | undefined)?.call;
      if (!isDesktopCall(call)) {
        throw { status: 400, code: 'MOCK_BAD_CALL', message: 'desktop_call without a method and path.' };
      }
      return await handleRoute(call.method.toLocaleUpperCase(), call.path, call.body);
    }
    return await handleCommand(command, args);
  }, { shouldMockEvents: true });

  /* Printed once, so it is obvious from the console alone which of the two dev
     modes produced what is on screen. */
  // eslint-disable-next-line no-console
  console.info(
    '%c[mock bridge]%c 浏览器模式：IPC 由 src/dev/mockBackend.ts 应答，数据是固定样例。'
      + '\n真实数据请用 pnpm desktop:dev。',
    'color:#3d6b8c;font-weight:600', '',
  );
}

export { MockRouteMissing };
