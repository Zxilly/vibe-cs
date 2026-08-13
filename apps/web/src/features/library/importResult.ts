import type { ScanResult } from '../../shared/desktop/dto';

export function requireSuccessfulImport(
  result: ScanResult,
  translate: (key: 'library.importNoChanges') => string,
): ScanResult {
  if (result.imported > 0 || result.updated > 0) return result;
  const details = result.errors.slice(0, 3).join('\n');
  throw new Error(details ? `${translate('library.importNoChanges')}\n${details}` : translate('library.importNoChanges'));
}
