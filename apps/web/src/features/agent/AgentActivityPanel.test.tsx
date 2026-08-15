import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AgentActivityPanel } from './AgentPage';
import { ProposalMutationCoordinator } from './proposalMutation';

describe('AgentActivityPanel', () => {
  it('presents video creation as a user task without internal tooling', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AgentActivityPanel
          activity={[{
            id: 'message-1:proposal:0',
            kind: 'proposal',
            name: 'NiKo round 21 highlight video',
            summary: '视频草案 · 1 高光证据',
            proposal: {
              kind: 'video_render',
              title: 'NiKo round 21 highlight video',
              payload: {
                items: [{
                  id: '00000000-0000-4000-8000-0000000000a1',
                  demo_id: '00000000-0000-4000-8000-0000000000d1',
                  highlight_id: '21:76561198041683378:173550-multikill',
                  player_id: '76561198041683378',
                  title: 'NiKo round 21',
                  start_tick: 173422,
                  end_tick: 174142,
                  pre_roll_seconds: 2,
                  post_roll_seconds: 2.5,
                  victim_pov: false,
                  camera_style: 'tracking',
                }],
                shot_designs: [{
                  highlight_id: '21:76561198041683378:173550-multikill',
                  map_name: 'de_mirage',
                  camera_intent: 'follow_entry',
                  camera_style: 'tracking',
                  rationale: '沿 NiKo 的进攻路线跟拍，保持交战方向可读。',
                  spatial_evidence: null,
                  requires_user_review: true,
                }],
                output: { container: 'mp4' },
                source_highlight_ids: ['21:76561198041683378:173550-multikill'],
                requires_user_confirmation: true,
              },
            },
          }]}
          projects={[]}
          selectedAudioAssetId=""
          mutationCoordinator={new ProposalMutationCoordinator()}
          mutationOwner={null}
          variant="dock"
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('agent-activity--dock');
    expect(markup).toContain('视频草案');
    expect(markup).toContain('打开录制计划并选择');
    expect(markup).not.toContain('生成 MP4');
    expect(markup).not.toContain('HLAE');
    expect(markup).not.toContain('managed capture');
  });
});
