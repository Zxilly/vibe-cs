use std::collections::BTreeMap;

use vibe_cs_cosmetics::{
    ACCOUNT_ID_PATH, CosmeticField, CosmeticFieldValue, CosmeticPatch, CosmeticTarget,
    CosmeticValues, EntitySnapshot, ITEM_DEFINITION_PATH, MatchBasis, ORIGINAL_OWNER_HIGH_PATH,
    ORIGINAL_OWNER_LOW_PATH, RewriteLimits, RewriteRequest, StablePlayerIdentity,
    plan_entity_rewrite,
};

const STEAM_ID_BASE: u64 = 76_561_197_960_265_728;
const ACCOUNT_ID: u32 = 12_345;

fn identity() -> StablePlayerIdentity {
    StablePlayerIdentity::new(STEAM_ID_BASE + u64::from(ACCOUNT_ID), ACCOUNT_ID).unwrap()
}

fn request(item_definition_index: Option<u16>) -> RewriteRequest {
    RewriteRequest {
        patches: vec![CosmeticPatch {
            target: CosmeticTarget {
                owner: identity(),
                item_definition_index,
            },
            values: CosmeticValues {
                paint_kit: Some(711),
                seed: Some(321),
                wear: Some(0.13),
                stat_trak: Some(42),
            },
        }],
    }
}

fn matching_snapshot() -> EntitySnapshot {
    let steam_id64 = identity().steam_id64;
    let mut fields = BTreeMap::new();
    fields.insert(
        ACCOUNT_ID_PATH.to_owned(),
        CosmeticFieldValue::Unsigned32(ACCOUNT_ID),
    );
    fields.insert(
        ORIGINAL_OWNER_LOW_PATH.to_owned(),
        CosmeticFieldValue::Unsigned32(u32::try_from(steam_id64 & u64::from(u32::MAX)).unwrap()),
    );
    fields.insert(
        ORIGINAL_OWNER_HIGH_PATH.to_owned(),
        CosmeticFieldValue::Unsigned32(u32::try_from(steam_id64 >> 32).unwrap()),
    );
    fields.insert(
        ITEM_DEFINITION_PATH.to_owned(),
        CosmeticFieldValue::Unsigned16(7),
    );
    fields.insert(
        CosmeticField::PaintKit.schema_path().to_owned(),
        CosmeticFieldValue::Unsigned32(1),
    );
    fields.insert(
        CosmeticField::Seed.schema_path().to_owned(),
        CosmeticFieldValue::Signed32(1),
    );
    fields.insert(
        CosmeticField::Wear.schema_path().to_owned(),
        CosmeticFieldValue::Float(0.9),
    );
    fields.insert(
        CosmeticField::StatTrak.schema_path().to_owned(),
        CosmeticFieldValue::Unsigned64(0),
    );
    EntitySnapshot {
        handle: 99,
        class_name: "C_WeaponFixture".to_owned(),
        fields,
    }
}

#[test]
fn stable_identity_and_item_filter_plan_type_preserving_replacements() {
    let plan = plan_entity_rewrite(
        &matching_snapshot(),
        &request(Some(7)),
        &RewriteLimits::default(),
    )
    .unwrap();

    assert!(plan.matched());
    assert_eq!(plan.patch_index, Some(0));
    assert_eq!(plan.match_basis, Some(MatchBasis::Both));
    assert_eq!(plan.replacements.len(), 4);
    assert_eq!(
        plan.replacements
            .iter()
            .find(|replacement| replacement.field == CosmeticField::Seed)
            .unwrap()
            .replacement,
        CosmeticFieldValue::Signed32(321)
    );
    assert_eq!(
        plan.replacements
            .iter()
            .find(|replacement| replacement.field == CosmeticField::StatTrak)
            .unwrap()
            .replacement,
        CosmeticFieldValue::Unsigned64(42)
    );
}

#[test]
fn account_id_alone_is_stable_match_evidence() {
    let mut snapshot = matching_snapshot();
    snapshot.fields.remove(ORIGINAL_OWNER_LOW_PATH);
    snapshot.fields.remove(ORIGINAL_OWNER_HIGH_PATH);

    let plan =
        plan_entity_rewrite(&snapshot, &request(Some(7)), &RewriteLimits::default()).unwrap();

    assert_eq!(plan.match_basis, Some(MatchBasis::AccountId));
}

#[test]
fn steam_id_alone_is_stable_match_evidence() {
    let mut snapshot = matching_snapshot();
    snapshot.fields.remove(ACCOUNT_ID_PATH);

    let plan =
        plan_entity_rewrite(&snapshot, &request(Some(7)), &RewriteLimits::default()).unwrap();

    assert_eq!(plan.match_basis, Some(MatchBasis::SteamId64));
}

#[test]
fn wrong_account_or_item_produces_no_plan() {
    let mut wrong_account = matching_snapshot();
    wrong_account.fields.insert(
        ACCOUNT_ID_PATH.to_owned(),
        CosmeticFieldValue::Unsigned32(ACCOUNT_ID + 1),
    );
    wrong_account.fields.remove(ORIGINAL_OWNER_LOW_PATH);
    wrong_account.fields.remove(ORIGINAL_OWNER_HIGH_PATH);
    let account_plan =
        plan_entity_rewrite(&wrong_account, &request(Some(7)), &RewriteLimits::default()).unwrap();
    assert!(!account_plan.matched());

    let item_plan = plan_entity_rewrite(
        &matching_snapshot(),
        &request(Some(9)),
        &RewriteLimits::default(),
    )
    .unwrap();
    assert!(!item_plan.matched());
}

#[test]
fn leaf_name_and_unknown_fields_cannot_inject_replacements() {
    let mut snapshot = matching_snapshot();
    snapshot
        .fields
        .remove(CosmeticField::PaintKit.schema_path());
    snapshot.fields.insert(
        "m_nFallbackPaintKit".to_owned(),
        CosmeticFieldValue::Unsigned32(1),
    );
    snapshot.fields.insert(
        "m_AttributeManager.m_Other.m_nFallbackPaintKit".to_owned(),
        CosmeticFieldValue::Unsigned32(1),
    );
    let request = RewriteRequest {
        patches: vec![CosmeticPatch {
            target: CosmeticTarget {
                owner: identity(),
                item_definition_index: Some(7),
            },
            values: CosmeticValues {
                paint_kit: Some(711),
                ..CosmeticValues::default()
            },
        }],
    };

    let plan = plan_entity_rewrite(&snapshot, &request, &RewriteLimits::default()).unwrap();

    assert!(plan.matched());
    assert!(plan.replacements.is_empty());
}

#[test]
fn existing_field_with_wrong_wire_type_is_reported_not_retyped() {
    let mut snapshot = matching_snapshot();
    snapshot.fields.insert(
        CosmeticField::PaintKit.schema_path().to_owned(),
        CosmeticFieldValue::Unsupported("String".to_owned()),
    );
    let request = RewriteRequest {
        patches: vec![CosmeticPatch {
            target: CosmeticTarget {
                owner: identity(),
                item_definition_index: Some(7),
            },
            values: CosmeticValues {
                paint_kit: Some(711),
                ..CosmeticValues::default()
            },
        }],
    };

    let plan = plan_entity_rewrite(&snapshot, &request, &RewriteLimits::default()).unwrap();

    assert!(plan.replacements.is_empty());
    assert!(plan.incompatible_fields.contains(&CosmeticField::PaintKit));
}

#[test]
fn request_rejects_inconsistent_identity_and_overlapping_targets() {
    assert!(StablePlayerIdentity::new(STEAM_ID_BASE + 5, 6).is_err());

    let patch = request(Some(7)).patches.remove(0);
    let overlapping = RewriteRequest {
        patches: vec![
            CosmeticPatch {
                target: CosmeticTarget {
                    owner: identity(),
                    item_definition_index: None,
                },
                values: CosmeticValues {
                    paint_kit: Some(1),
                    ..CosmeticValues::default()
                },
            },
            patch,
        ],
    };
    assert!(overlapping.validate(&RewriteLimits::default()).is_err());
}
