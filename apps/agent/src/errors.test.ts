import { describe, expect, it } from 'vitest';

import { safeUpstreamError } from './errors.js';

describe('upstream error redaction', () => {
  it('keeps status and stable code but never the body or API key', () => {
    const key = 'secret-development-key';
    const error = safeUpstreamError({
      statusCode: 400,
      responseBody: JSON.stringify({ error: { code: 'invalid_request', message: `echo ${key}` } }),
    });
    expect(error.message).toContain('HTTP 400');
    expect(error.message).toContain('code=invalid_request');
    expect(error.message).not.toContain(key);
    expect(error.message).not.toContain('echo');
  });
});
