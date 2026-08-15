import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { RetryNotice, retriesExhausted } from './RetryNotice';

const ACTION = { label: '查看阶段', onAction: () => undefined };

describe('retriesExhausted', () => {
  it('is spent exactly when the used count reaches the allowance', () => {
    expect(retriesExhausted(0, 2)).toBe(false);
    expect(retriesExhausted(1, 2)).toBe(false);
    expect(retriesExhausted(2, 2)).toBe(true);
    expect(retriesExhausted(3, 2)).toBe(true);
  });

  it('is spent from the start when no retry is allowed at all', () => {
    expect(retriesExhausted(0, 0)).toBe(true);
  });
});

describe('RetryNotice', () => {
  it('counts the retry in flight', () => {
    const markup = renderMarkup(<RetryNotice retries={2} maxRetries={3} action={ACTION} />);

    expect(markup).toContain('第 2 次重试');
    expect(markup).not.toContain('已达上限');
  });

  it('says the budget is spent, and says it in a different tone', () => {
    const markup = renderMarkup(<RetryNotice retries={2} maxRetries={2} action={ACTION} />);

    expect(markup).toContain('已重试 2 次');
    expect(markup).toContain('已达上限，不再自动重试');
    expect(markup).toContain('data-tone="danger"');
  });

  it('is a warning while the system is still handling it', () => {
    const markup = renderMarkup(<RetryNotice retries={1} maxRetries={2} action={ACTION} />);

    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain('警告');
  });

  it('is a Notice, so it carries a recovery action and does not auto-dismiss', () => {
    const markup = renderMarkup(<RetryNotice retries={1} maxRetries={2} action={ACTION} />);

    expect(markup).toContain('data-notice-action="primary"');
    expect(markup).toContain('查看阶段');
  });

  it('prints what the retry means, when the caller can explain it', () => {
    const markup = renderMarkup(
      <RetryNotice
        retries={1}
        maxRetries={2}
        explanation="第 3 个片段开始时观察者身份没有立即确认，系统重新跳转后再采集。成片不受影响。"
        action={ACTION}
      />,
    );

    expect(markup).toContain('系统重新跳转后再采集');
  });

  it('does not print a negative or fractional count', () => {
    expect(renderMarkup(<RetryNotice retries={-3} maxRetries={2} action={ACTION} />))
      .toContain('第 0 次重试');
    expect(renderMarkup(<RetryNotice retries={1.7} maxRetries={4} action={ACTION} />))
      .toContain('第 1 次重试');
  });
});
