import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useTaskFeed } from '../../data/tasks';
import { Drawer } from '../../design/feedback';
import { Button } from '../../design/primitives';
import { TaskActivityList } from './TaskActivityList';
import { TaskDetailBody } from './TaskDetailBody';
import { TASK_POLL_FEED_MS } from './taskPolling';
import { useTaskActions } from './useTaskActions';
import {
  activityStatusChanges,
  activityStatusSnapshot,
  type ActivityStatusSnapshot,
} from './activityUnread';

export interface ActivityDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUnreadChange: (count: number) => void;
}

export function ActivityDrawer({ open, onClose, onUnreadChange }: ActivityDrawerProps) {
  const feed = useTaskFeed({ page: 1, page_size: 50 }, { pollWhileActiveMs: TASK_POLL_FEED_MS });
  const bind = useTaskActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const previous = useRef<ActivityStatusSnapshot | null>(null);

  const items = feed.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (feed.data === undefined) return;
    const changes = activityStatusChanges(previous.current, feed.data.items);
    previous.current = activityStatusSnapshot(feed.data.items);
    setUnread((current) => (open ? 0 : current + changes));
  }, [feed.data, open]);

  useEffect(() => {
    onUnreadChange(unread);
  }, [onUnreadChange, unread]);

  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  return (
    <Drawer
      open={open}
      title={selected === null ? <Trans>后台任务</Trans> : <Trans>后台任务详情</Trans>}
      onClose={onClose}
    >
      {selected === null ? (
        <TaskActivityList
          items={items}
          total={feed.data?.total ?? 0}
          isLoading={feed.isPending}
          error={feed.isError ? dataErrorMessage(feed.error) ?? t`读取后台任务失败。` : null}
          onReload={() => void feed.refetch()}
          bind={bind}
          onSelect={setSelectedId}
        />
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} className="self-start">
            <Trans>‹ 返回后台任务</Trans>
          </Button>
          <TaskDetailBody item={selected} compact />
        </div>
      )}
    </Drawer>
  );
}
