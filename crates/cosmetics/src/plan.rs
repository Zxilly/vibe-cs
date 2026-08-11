use std::collections::BTreeSet;

use crate::{
    ACCOUNT_ID_PATH, CosmeticField, CosmeticFieldValue, EntityRewritePlan, EntitySnapshot,
    ITEM_DEFINITION_PATH, MatchBasis, ORIGINAL_OWNER_HIGH_PATH, ORIGINAL_OWNER_LOW_PATH,
    PlannedFieldRewrite, RewriteError, RewriteLimits, RewriteRequest,
};

/// Creates a deterministic, type-preserving rewrite plan for one entity.
///
/// Only full paths from the fixed allowlist are read. Unknown fields in the
/// snapshot are ignored and can never become output fields.
///
/// # Errors
///
/// Returns [`RewriteError`] when the request or limits are invalid.
pub fn plan_entity_rewrite(
    snapshot: &EntitySnapshot,
    request: &RewriteRequest,
    limits: &RewriteLimits,
) -> Result<EntityRewritePlan, RewriteError> {
    request.validate(limits)?;
    Ok(plan_validated_entity_rewrite(snapshot, request))
}

pub(crate) fn plan_validated_entity_rewrite(
    snapshot: &EntitySnapshot,
    request: &RewriteRequest,
) -> EntityRewritePlan {
    for (patch_index, patch) in request.patches.iter().enumerate() {
        let account_matches = snapshot
            .fields
            .get(ACCOUNT_ID_PATH)
            .and_then(CosmeticFieldValue::as_u64)
            == Some(u64::from(patch.target.owner.account_id));

        let steam_id = snapshot
            .fields
            .get(ORIGINAL_OWNER_LOW_PATH)
            .and_then(CosmeticFieldValue::as_u64)
            .zip(
                snapshot
                    .fields
                    .get(ORIGINAL_OWNER_HIGH_PATH)
                    .and_then(CosmeticFieldValue::as_u64),
            )
            .and_then(|(low, high)| {
                let low = u32::try_from(low).ok()?;
                let high = u32::try_from(high).ok()?;
                Some((u64::from(high) << 32) | u64::from(low))
            });
        let steam_matches = steam_id == Some(patch.target.owner.steam_id64);
        if !account_matches && !steam_matches {
            continue;
        }

        if let Some(expected_item) = patch.target.item_definition_index {
            let actual_item = snapshot
                .fields
                .get(ITEM_DEFINITION_PATH)
                .and_then(CosmeticFieldValue::as_u64);
            if actual_item != Some(u64::from(expected_item)) {
                continue;
            }
        }

        let match_basis = match (account_matches, steam_matches) {
            (true, true) => MatchBasis::Both,
            (true, false) => MatchBasis::AccountId,
            (false, true) => MatchBasis::SteamId64,
            (false, false) => unreachable!("identity match checked above"),
        };
        let mut replacements = Vec::new();
        let mut incompatible_fields = BTreeSet::new();
        for field in CosmeticField::ALL {
            if !patch.values.requested(field) {
                continue;
            }
            let path = field.schema_path();
            let Some(current) = snapshot.fields.get(path) else {
                continue;
            };
            let replacement = match field {
                CosmeticField::PaintKit => patch
                    .values
                    .paint_kit
                    .and_then(|value| current.replace_unsigned_like(value)),
                CosmeticField::Seed => patch
                    .values
                    .seed
                    .and_then(|value| current.replace_unsigned_like(value)),
                CosmeticField::Wear => patch.values.wear.and_then(|value| {
                    matches!(current, CosmeticFieldValue::Float(_))
                        .then_some(CosmeticFieldValue::Float(value))
                }),
                CosmeticField::StatTrak => patch
                    .values
                    .stat_trak
                    .and_then(|value| current.replace_unsigned_like(value)),
            };
            if let Some(replacement) = replacement {
                replacements.push(PlannedFieldRewrite {
                    field,
                    schema_path: path.to_owned(),
                    current: current.clone(),
                    replacement,
                });
            } else {
                incompatible_fields.insert(field);
            }
        }

        return EntityRewritePlan {
            patch_index: Some(patch_index),
            match_basis: Some(match_basis),
            replacements,
            incompatible_fields,
        };
    }

    EntityRewritePlan {
        patch_index: None,
        match_basis: None,
        replacements: Vec::new(),
        incompatible_fields: BTreeSet::new(),
    }
}
