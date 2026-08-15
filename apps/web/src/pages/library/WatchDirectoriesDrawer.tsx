/*
 * pages/library — 「监听目录」, behind the toolbar's secondary button.
 *
 * The artboard draws only the *adding* half as a dialog (「添加监听目录」). The
 * other half — which folders are being watched, whether each one is still
 * there, and 「停止监听」 — has to live somewhere, and it is not a confirmation:
 * it is a list you read and edit while the table behind it stays useful. That
 * is the artboard's own definition of a Drawer (「Drawer 承载详情与非阻断编辑」),
 * so this is a Drawer, and the add step it launches stays the drawn Dialog.
 *
 * What each row shows is `DemoWatchStatus.roots[]` verbatim — `state` is the
 * service's own word (`watching | missing | rejected | duplicate | error |
 * disabled`) and `message` its own explanation. A rejected root is exactly the
 * artboard's 「不接受符号链接根目录」 arriving as an answer instead of a guess.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Drawer, Notice, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { Button } from '../../design/primitives';
import type { DemoWatchRootStatus, DemoWatchStatus } from '../../shared/desktop/dto';
import { alsoDisabled, type ServiceActionButtonProps } from './serviceAction';

/** The service's six root states, in dots. */
const ROOT_DOT: Readonly<Record<DemoWatchRootStatus['state'], StatusDotStatus>> = {
  watching: 'ok',
  missing: 'fail',
  rejected: 'fail',
  duplicate: 'warn',
  error: 'fail',
  disabled: 'idle',
};

export interface WatchDirectoriesDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly status: DemoWatchStatus | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onAdd: () => void;
  readonly onRemove: (path: string) => void;
  readonly onRescan: () => void;
  readonly busy: boolean;
  readonly service: ServiceActionButtonProps;
  readonly serviceSuffix: ReactNode | undefined;
}

export function WatchDirectoriesDrawer({
  open,
  onClose,
  status,
  loading,
  error,
  onRetry,
  onAdd,
  onRemove,
  onRescan,
  busy,
  service,
  serviceSuffix,
}: WatchDirectoriesDrawerProps) {
  const roots = status?.roots ?? [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={<Trans>监听目录</Trans>}
      description={<Plural value={roots.length} other="# 个目录" />}
      footer={
        <>
          <Button size="sm" onClick={onRescan} {...alsoDisabled(service, busy)}>
            <Trans>重新扫描</Trans>
            {serviceSuffix}
          </Button>
          <Button size="sm" variant="primary" onClick={onAdd} {...service}>
            <Trans>添加目录</Trans>
            {serviceSuffix}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error === null ? null : (
          <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
            {error}
          </Notice>
        )}

        {loading ? (
          <p className="text-sm text-neutral-600">
            <Trans>正在读取监听状态</Trans>
          </p>
        ) : null}

        {!loading && roots.length === 0 ? (
          <p className="text-sm leading-normal text-neutral-700">
            <Trans>还没有监听目录。添加一个之后，新的 .dem 会自动入库。</Trans>
          </p>
        ) : null}

        <ul className="flex flex-col">
          {roots.map((root) => (
            <li
              key={root.path}
              className="flex min-h-[var(--h-row)] items-center gap-3 border-b border-divider py-2"
            >
              <StatusDot status={ROOT_DOT[root.state]} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-xs" title={root.path}>
                  {root.path}
                </span>
                {root.message === null ? null : (
                  <span className="truncate text-2xs text-neutral-600">{root.message}</span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t`停止监听 ${root.path}`}
                onClick={() => {
                  onRemove(root.path);
                }}
                {...alsoDisabled(service, busy)}
              >
                <Trans>停止监听</Trans>
              </Button>
            </li>
          ))}
        </ul>

        {status === undefined ? null : (
          <p className="text-xs leading-normal text-neutral-600">
            <Trans>
              上次扫描导入 {status.imported} 个 · 更新 {status.updated} 个 · 缺失 {status.missing} 个
            </Trans>
          </p>
        )}
      </div>
    </Drawer>
  );
}
