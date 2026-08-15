/**
 * `unit` project — a rejected read, in the shape a Notice can render.
 *
 * `DesktopError` is imported from the real client so the assertions run against
 * the class the bridge actually throws, not a lookalike. Importing the module
 * does not touch IPC — nothing here calls `invoke`.
 */

import { describe, expect, it } from 'vitest';

import { DesktopError } from '../shared/desktop/client';
import { dataErrorMessage, toDataError } from './errors';

describe('dataErrorMessage', () => {
  it('reads the service’s own message off a DesktopError', () => {
    expect(dataErrorMessage(new DesktopError('本地服务未启动', 0, 'DESKTOP_COMMAND_FAILED'))).toBe(
      '本地服务未启动',
    );
  });

  it('reads a plain Error, which is what the contract parsers throw', () => {
    expect(dataErrorMessage(new Error('Demo response does not match the current contract.'))).toBe(
      'Demo response does not match the current contract.',
    );
  });

  it('reads a bare string rejection', () => {
    expect(dataErrorMessage('boom')).toBe('boom');
  });

  it('reads a message off a plain object without stringifying the object', () => {
    expect(dataErrorMessage({ message: 'nope' })).toBe('nope');
    // The failure mode this guards: `[object Object]` in a banner.
    expect(dataErrorMessage({ detail: 'nope' })).toBeNull();
  });

  it('returns null when there is nothing readable', () => {
    expect(dataErrorMessage(null)).toBeNull();
    expect(dataErrorMessage(undefined)).toBeNull();
    expect(dataErrorMessage('')).toBeNull();
    expect(dataErrorMessage(new Error(''))).toBeNull();
    expect(dataErrorMessage(42)).toBeNull();
  });
});

describe('toDataError', () => {
  it('carries the status and code the routes return', () => {
    const error = toDataError(new DesktopError('方案已被改动', 409, 'PLAN_REVISION_STALE'), '出错了');
    expect(error).toEqual({ message: '方案已被改动', status: 409, code: 'PLAN_REVISION_STALE' });
  });

  it('reports a transport failure as status 0, not as a missing status', () => {
    const error = toDataError(new DesktopError('请求超时', 0, 'REQUEST_ABORTED'), '出错了');
    expect(error?.status).toBe(0);
  });

  it('falls back only for the message, never inventing a code', () => {
    expect(toDataError(new Error(''), '读取失败')).toEqual({
      message: '读取失败',
      status: null,
      code: null,
    });
    expect(toDataError(42, '读取失败')).toEqual({ message: '读取失败', status: null, code: null });
  });

  it('is null when the query did not fail', () => {
    expect(toDataError(null, '读取失败')).toBeNull();
    expect(toDataError(undefined, '读取失败')).toBeNull();
  });
});
