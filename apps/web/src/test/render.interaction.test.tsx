import { Trans } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from './render';

function Probe() {
  const query = useQuery({ queryKey: ['render-harness-probe'], queryFn: () => 'ready' });
  return (
    <button type="button" data-status={query.data ?? 'pending'}>
      <Trans>确认并生成视频</Trans>
    </button>
  );
}

// Guards the jsdom side of the harness: real DOM, Query provider resolving,
// macro copy in the source locale.
describe('renderInteractive', () => {
  it('mounts into jsdom with both providers applied', async () => {
    const { findByRole } = renderInteractive(<Probe />);
    const button = await findByRole('button');

    expect(button.textContent).toBe('确认并生成视频');
    expect(document.body.contains(button)).toBe(true);
    await expect.poll(() => button.dataset['status']).toBe('ready');
  });
});
