import { describe, expect, it } from 'vitest';

import { formatWeaponName, weaponSearchId } from './weaponNames';

describe('formatWeaponName', () => {
  it('turns the demo id into the product name the reference draws', () => {
    expect(formatWeaponName('ak47')).toBe('AK-47');
    expect(formatWeaponName('usp_silencer')).toBe('USP-S');
    expect(formatWeaponName('fiveseven')).toBe('Five-SeveN');
    expect(formatWeaponName('m4a1_silencer')).toBe('M4A1-S');
  });

  it('accepts the entity-prefixed spelling and every knife skin', () => {
    expect(formatWeaponName('weapon_deagle')).toBe('Desert Eagle');
    expect(formatWeaponName('knife_karambit')).toBe('Knife');
    expect(formatWeaponName('bayonet')).toBe('Knife');
  });

  it('shows an unknown id as it came rather than blank', () => {
    expect(formatWeaponName('Kevlar Vest')).toBe('Kevlar Vest');
    expect(formatWeaponName('mystery_gun')).toBe('mystery_gun');
  });
});

describe('weaponSearchId', () => {
  it('maps either spelling onto the id the index keys on', () => {
    expect(weaponSearchId('AK-47')).toBe('ak47');
    expect(weaponSearchId('ak-47')).toBe('ak47');
    expect(weaponSearchId('ak47')).toBe('ak47');
    expect(weaponSearchId(' USP-S ')).toBe('usp_silencer');
  });

  it('passes an unknown term on, keyed the way the index lower-cases it', () => {
    expect(weaponSearchId('Kevlar Vest')).toBe('kevlar vest');
  });
});
