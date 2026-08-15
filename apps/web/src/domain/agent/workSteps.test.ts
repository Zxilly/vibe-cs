import { i18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { AGENT_WORK_STEP_STATE, AGENT_WORK_STEP_STATES } from './workSteps';

i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });

describe('AGENT_WORK_STEP_STATE', () => {
  it('covers the union, and the union covers the table', () => {
    expect(AGENT_WORK_STEP_STATES).toHaveLength(Object.keys(AGENT_WORK_STEP_STATE).length);
    for (const state of AGENT_WORK_STEP_STATES) {
      expect(AGENT_WORK_STEP_STATE[state]).toBeDefined();
    }
  });

  it('gives every state a word, so the marker is never the only reading', () => {
    const labels = AGENT_WORK_STEP_STATES.map((state) => i18n._(AGENT_WORK_STEP_STATE[state].label));

    expect(labels.every((label) => label.length > 0)).toBe(true);
    // No two states share a reading — a trail whose 「done」 and 「waiting」 sound
    // the same is a trail that says nothing.
    expect(new Set(labels).size).toBe(labels.length);
  });
});
