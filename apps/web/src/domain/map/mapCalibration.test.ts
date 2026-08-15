import { describe, expect, it } from 'vitest';

import {
  calibrationFromOverview,
  findMapCalibration,
  isUsableCalibration,
  MAP_CALIBRATIONS,
  normaliseMapName,
  OVERVIEW_IMAGE_SIZE,
  resolveMapCalibration,
} from './mapCalibration';

describe('normaliseMapName', () => {
  it('lower-cases, trims and supplies the default prefix', () => {
    expect(normaliseMapName(' DE_Mirage ')).toBe('de_mirage');
    expect(normaliseMapName('Mirage')).toBe('de_mirage');
    expect(normaliseMapName('cs_office')).toBe('cs_office');
    expect(normaliseMapName('   ')).toBe('');
  });
});

describe('the built-in table', () => {
  it('carries de_mirage with the values this repository can check', () => {
    const mirage = findMapCalibration('de_mirage');
    expect(mirage).not.toBeNull();
    expect(mirage?.originX).toBe(-3230);
    expect(mirage?.originY).toBe(1713);
    expect(mirage?.unitsPerPixel).toBe(5);
    expect(mirage?.overviewSize).toBe(OVERVIEW_IMAGE_SIZE);
  });

  it('marks de_mirage verified, because two files in this repository agree with it', () => {
    expect(findMapCalibration('de_mirage')?.confidence).toBe('verified');
  });

  /*
   * The point of this test is not the numbers, it is the flag. de_inferno's
   * transform is not reproduced anywhere in this repository, so the entry has to
   * keep announcing that it is a placeholder — `MapCanvas` renders a warning off
   * this field. If someone lands a checked-in fixture for inferno and flips the
   * flag, this test is the reminder to also drop the PLACEHOLDER note.
   */
  it('keeps de_inferno marked provisional and says so in its provenance', () => {
    const inferno = findMapCalibration('de_inferno');
    expect(inferno?.confidence).toBe('provisional');
    expect(inferno?.provenance).toContain('PLACEHOLDER');
  });

  it('names every entry in its normalised form and gives every entry a provenance', () => {
    for (const entry of MAP_CALIBRATIONS) {
      expect(entry.mapName).toBe(normaliseMapName(entry.mapName));
      expect(entry.provenance.length).toBeGreaterThan(0);
      expect(isUsableCalibration(entry)).toBe(true);
    }
  });

  it('returns null for a map it does not know', () => {
    expect(findMapCalibration('de_nuke')).toBeNull();
    expect(findMapCalibration('')).toBeNull();
  });
});

describe('isUsableCalibration', () => {
  const base = {
    mapName: 'de_test',
    originX: 0,
    originY: 0,
    unitsPerPixel: 4,
    overviewSize: 1024,
    confidence: 'verified',
    provenance: 'test',
  } as const;

  it('rejects the values that would collapse or poison the projection', () => {
    expect(isUsableCalibration(base)).toBe(true);
    expect(isUsableCalibration({ ...base, unitsPerPixel: 0 })).toBe(false);
    expect(isUsableCalibration({ ...base, unitsPerPixel: -4 })).toBe(false);
    expect(isUsableCalibration({ ...base, overviewSize: 0 })).toBe(false);
    expect(isUsableCalibration({ ...base, originX: Number.NaN })).toBe(false);
    expect(isUsableCalibration({ ...base, originY: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isUsableCalibration(null)).toBe(false);
    expect(isUsableCalibration(undefined)).toBe(false);
  });
});

describe('calibrationFromOverview', () => {
  it('renames the wire fields and marks the result verified', () => {
    const calibration = calibrationFromOverview('de_mirage', {
      pos_x: -3230,
      pos_y: 1713,
      scale: 5,
      rotate: false,
      zoom: null,
    });
    expect(calibration).toMatchObject({
      mapName: 'de_mirage',
      originX: -3230,
      originY: 1713,
      unitsPerPixel: 5,
      confidence: 'verified',
    });
  });

  it('ignores rotate and zoom, per the note in shared/radar.ts', () => {
    const plain = calibrationFromOverview('de_x', { pos_x: 1, pos_y: 2, scale: 3 });
    const decorated = calibrationFromOverview('de_x', { pos_x: 1, pos_y: 2, scale: 3, rotate: true, zoom: 1.1 });
    expect(decorated).toEqual(plain);
  });

  it('refuses an unusable transform instead of repairing it', () => {
    expect(calibrationFromOverview('de_x', { pos_x: 0, pos_y: 0, scale: 0 })).toBeNull();
    expect(calibrationFromOverview('de_x', null)).toBeNull();
    expect(calibrationFromOverview('de_x', undefined)).toBeNull();
  });
});

describe('resolveMapCalibration', () => {
  it('prefers the live transform over the built-in table', () => {
    const resolved = resolveMapCalibration('de_mirage', { pos_x: -1, pos_y: 1, scale: 2 });
    expect(resolved?.originX).toBe(-1);
    expect(resolved?.confidence).toBe('verified');
  });

  it('falls through to the table when the live transform is unusable', () => {
    const resolved = resolveMapCalibration('de_mirage', { pos_x: -1, pos_y: 1, scale: 0 });
    expect(resolved?.originX).toBe(-3230);
  });

  it('returns null when neither source has anything, so the caller renders a state', () => {
    expect(resolveMapCalibration('de_nuke')).toBeNull();
  });
});
