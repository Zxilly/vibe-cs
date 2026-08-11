import { describe, expect, it } from 'vitest';

import { isDesktopLocation, isSafeExternalHttpsUrl } from './dialog';

describe('desktop dialog environment detection', () => {
  it('recognizes packaged and development webviews without treating browsers as desktop', () => {
    expect(isDesktopLocation({ protocol: 'tauri:', hostname: '', hasTauriInternals: false })).toBe(true);
    expect(isDesktopLocation({ protocol: 'https:', hostname: 'tauri.localhost', hasTauriInternals: false })).toBe(true);
    expect(isDesktopLocation({ protocol: 'http:', hostname: 'localhost', hasTauriInternals: true })).toBe(true);
    expect(isDesktopLocation({ protocol: 'http:', hostname: 'localhost', hasTauriInternals: false })).toBe(false);
  });
});

describe('external URL boundary', () => {
  it('accepts public HTTPS pages and rejects credentials or local hosts', () => {
    expect(isSafeExternalHttpsUrl('https://downloads.example.com/release')).toBe(true);
    expect(isSafeExternalHttpsUrl('http://downloads.example.com/release')).toBe(false);
    expect(isSafeExternalHttpsUrl('https://user:secret@downloads.example.com/release')).toBe(false);
    expect(isSafeExternalHttpsUrl('https://127.0.0.1/release')).toBe(false);
  });
});
