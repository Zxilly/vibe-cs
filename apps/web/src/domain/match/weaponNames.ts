/*
 * Domain layer, 2 of 3 — match/, the weapon id ⇄ product name boundary.
 *
 * The demo spells a weapon as its entity id — `usp_silencer`, `ak47`,
 * `fiveseven` — and the analyser stores that string verbatim on every kill,
 * highlight and evidence row. The reference draws the product name instead:
 * 「Kael → Sable · AK-47 · 爆头」 on the evidence row, 「AK-47 16 杀」 on the
 * player tiles. This table is the one place the two vocabularies meet, so a row
 * and its filter chip cannot drift apart: `formatWeaponName` turns the id into
 * the name for display, `weaponSearchId` turns whatever a person typed — either
 * spelling — back into the id the index matches on.
 *
 * Names are the in-game product names, which are brands and stay untranslated.
 * An id the table has not heard of is shown as it came, which is visibly odd
 * rather than silently blank; purchases in particular already arrive with an
 * item name (「Kevlar Vest」) rather than an id.
 */

const WEAPON_NAME: Readonly<Record<string, string>> = {
  /* pistols */
  glock: 'Glock-18',
  hkp2000: 'P2000',
  usp_silencer: 'USP-S',
  elite: 'Dual Berettas',
  p250: 'P250',
  fiveseven: 'Five-SeveN',
  tec9: 'Tec-9',
  cz75a: 'CZ75-Auto',
  deagle: 'Desert Eagle',
  revolver: 'R8 Revolver',
  /* SMGs */
  mac10: 'MAC-10',
  mp9: 'MP9',
  mp7: 'MP7',
  mp5sd: 'MP5-SD',
  ump45: 'UMP-45',
  p90: 'P90',
  bizon: 'PP-Bizon',
  /* rifles */
  famas: 'FAMAS',
  galilar: 'Galil AR',
  m4a1: 'M4A4',
  m4a1_silencer: 'M4A1-S',
  ak47: 'AK-47',
  aug: 'AUG',
  sg556: 'SG 553',
  ssg08: 'SSG 08',
  awp: 'AWP',
  scar20: 'SCAR-20',
  g3sg1: 'G3SG1',
  /* heavy */
  nova: 'Nova',
  xm1014: 'XM1014',
  mag7: 'MAG-7',
  sawedoff: 'Sawed-Off',
  m249: 'M249',
  negev: 'Negev',
  /* equipment */
  taser: 'Zeus x27',
  knife: 'Knife',
  hegrenade: 'HE Grenade',
  flashbang: 'Flashbang',
  smokegrenade: 'Smoke Grenade',
  molotov: 'Molotov',
  incgrenade: 'Incendiary Grenade',
  decoy: 'Decoy Grenade',
  c4: 'C4',
};

/** `weapon_ak47` → `ak47`, every `knife_*` skin → `knife`. */
function canonicalWeaponId(value: string): string {
  const id = value.trim().toLowerCase().replace(/^weapon_/u, '');
  return id.startsWith('knife') || id === 'bayonet' ? 'knife' : id;
}

const WEAPON_ID_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(WEAPON_NAME).map(([id, name]) => [name.toLowerCase(), id]),
);

/** 「AK-47」 for `ak47`; an unknown id comes back as it was written. */
export function formatWeaponName(weapon: string): string {
  return WEAPON_NAME[canonicalWeaponId(weapon)] ?? weapon;
}

/**
 * The id the index filters on, from either spelling. 「AK-47」, 「ak-47」 and
 * `ak47` all become `ak47`; text that is neither a known name nor a known id is
 * passed on as typed, lower-cased the way the index keys it.
 */
export function weaponSearchId(text: string): string {
  const trimmed = text.trim();
  return WEAPON_ID_BY_NAME.get(trimmed.toLowerCase()) ?? canonicalWeaponId(trimmed);
}
