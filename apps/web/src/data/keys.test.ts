import { describe, expect, it } from 'vitest';

import { isKeyPrefixOf, qk, QUERY_NAMESPACE } from './keys';

describe('canonical query keys', () => {
  it('keeps all Project resources below one Project detail key', () => {
    const detail = qk.projects.detail('project-1');
    expect(isKeyPrefixOf(detail, qk.projects.changeGroups('project-1'))).toBe(true);
    expect(isKeyPrefixOf(detail, qk.projects.deliveryGate('project-1'))).toBe(true);
    expect(isKeyPrefixOf(detail, qk.projects.editLease('project-1'))).toBe(true);
  });

  it('contains no retired Plan, Montage, or Editor namespace', () => {
    expect(Object.values(QUERY_NAMESPACE)).not.toContain('plans');
    expect(Object.values(QUERY_NAMESPACE)).not.toContain('montage');
    expect(Object.values(QUERY_NAMESPACE)).not.toContain('editor');
  });
});
