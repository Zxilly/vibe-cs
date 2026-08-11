type UpstreamError = {
  statusCode?: unknown;
  responseBody?: unknown;
  cause?: unknown;
};

export function safeUpstreamError(error: unknown): Error {
  const candidate = error !== null && typeof error === 'object' ? error as UpstreamError : {};
  const status = typeof candidate.statusCode === 'number' ? ` HTTP ${candidate.statusCode}` : '';
  let code = '';
  if (typeof candidate.responseBody === 'string' && candidate.responseBody.length <= 64 * 1024) {
    try {
      const parsed = JSON.parse(candidate.responseBody) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        const root = parsed as Record<string, unknown>;
        const detail = root.error !== null && typeof root.error === 'object'
          ? root.error as Record<string, unknown>
          : root;
        const value = [detail.param, detail.code, detail.type].find((item) => typeof item === 'string');
        if (typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/iu.test(value)) code = ` code=${value}`;
      }
    } catch {
      // The upstream body is intentionally not surfaced.
    }
  }
  return new Error(`upstream model request failed (${`${status}${code}`.trim() || 'network error'})`);
}
