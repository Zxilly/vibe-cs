use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::thread;

use source2_demo::proto::{CSvcMsgPacketEntities, EDemoCommands, Message, SvcMessages};
use source2_demo::{
    Context, DemoRunner, Entity, EntityEvents, Interests, Observer, ObserverResult, Parser,
};

use crate::source2_backend::snapshot_entity;
use crate::{
    ACCOUNT_ID_PATH, CosmeticField, CosmeticFieldValue, CosmeticInspectionItem,
    CosmeticInspectionReport, EntitySnapshot, ITEM_DEFINITION_PATH, LimitKind, MatchBasis,
    ORIGINAL_OWNER_HIGH_PATH, ORIGINAL_OWNER_LOW_PATH, RewriteError, RewriteLimits,
    StablePlayerIdentity,
};

const SOURCE2_WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;
const STEAM_ID64_INDIVIDUAL_BASE: u64 = 76_561_197_960_265_728;

/// Inspects only the fixed identity, item-definition, and fallback cosmetic
/// fields used by the safe rewrite planner.
///
/// # Errors
///
/// Returns [`RewriteError`] when the path or demo is invalid, parsing fails,
/// or a configured resource bound is exceeded.
pub fn inspect_demo(
    input: impl AsRef<Path>,
    limits: &RewriteLimits,
) -> Result<CosmeticInspectionReport, RewriteError> {
    limits.validate()?;
    let input = resolve_input(input.as_ref())?;
    let input_bytes = input
        .metadata()
        .map_err(|error| RewriteError::io("inspect input", &input, error))?
        .len();
    if input_bytes > limits.max_input_bytes {
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::InputBytes,
            limit: limits.max_input_bytes,
            observed: input_bytes,
        });
    }

    let parser_path = input.clone();
    let limits = *limits;
    let parsed = thread::scope(|scope| {
        let worker = thread::Builder::new()
            .name("vibe-cs-cosmetics-inspector".to_owned())
            .stack_size(SOURCE2_WORKER_STACK_BYTES)
            .spawn_scoped(scope, move || inspect_source2(&parser_path, limits))
            .map_err(|error| RewriteError::io("start inspection worker", &input, error))?;
        worker.join().map_err(|_| {
            RewriteError::Backend(crate::BackendError::Stream(
                "Source 2 inspection worker panicked".to_owned(),
            ))
        })?
    })?;

    Ok(CosmeticInspectionReport {
        input_path: input,
        input_bytes,
        demo_messages: parsed.demo_messages,
        entity_updates: parsed.entity_updates,
        distinct_entities: parsed.distinct_entities,
        items: aggregate_items(&parsed.snapshots),
    })
}

fn resolve_input(input: &Path) -> Result<PathBuf, RewriteError> {
    if !input.is_absolute() {
        return Err(RewriteError::PathNotAbsolute {
            role: "input",
            path: input.to_path_buf(),
        });
    }
    if !input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dem"))
    {
        return Err(RewriteError::InvalidExtension {
            role: "input",
            path: input.to_path_buf(),
        });
    }
    let input =
        fs::canonicalize(input).map_err(|error| RewriteError::io("resolve input", input, error))?;
    if !input
        .metadata()
        .map_err(|error| RewriteError::io("inspect input", &input, error))?
        .is_file()
    {
        return Err(RewriteError::invalid("input must be a regular file"));
    }
    Ok(input)
}

#[derive(Debug)]
struct ParsedInspection {
    demo_messages: u64,
    entity_updates: u64,
    distinct_entities: u64,
    snapshots: Vec<EntitySnapshot>,
}

fn inspect_source2(input: &Path, limits: RewriteLimits) -> Result<ParsedInspection, RewriteError> {
    let file = File::open(input).map_err(|error| RewriteError::io("open input", input, error))?;
    let mut parser = Parser::from_reader(file)
        .map_err(|error| RewriteError::Backend(crate::BackendError::Stream(error.to_string())))?;
    let state = parser.add_observer(CosmeticInspectionObserver::new(limits));
    let run_result = parser.run_to_end();
    let mut state = state.borrow_mut();
    if let Some((kind, limit, observed)) = state.limit_violation.take() {
        return Err(RewriteError::LimitExceeded {
            kind,
            limit,
            observed,
        });
    }
    run_result
        .map_err(|error| RewriteError::Backend(crate::BackendError::Stream(error.to_string())))?;
    Ok(ParsedInspection {
        demo_messages: state.demo_messages,
        entity_updates: state.entity_updates,
        distinct_entities: state.distinct_entities.len() as u64,
        snapshots: std::mem::take(&mut state.snapshots).into_values().collect(),
    })
}

#[derive(Debug)]
struct CosmeticInspectionObserver {
    limits: RewriteLimits,
    demo_messages: u64,
    entity_updates: u64,
    distinct_entities: HashSet<u32>,
    snapshots: BTreeMap<u32, EntitySnapshot>,
    limit_violation: Option<(LimitKind, u64, u64)>,
}

impl CosmeticInspectionObserver {
    fn new(limits: RewriteLimits) -> Self {
        Self {
            limits,
            demo_messages: 0,
            entity_updates: 0,
            distinct_entities: HashSet::new(),
            snapshots: BTreeMap::new(),
            limit_violation: None,
        }
    }

    fn fail_limit(&mut self, kind: LimitKind, limit: u64, observed: u64) -> ObserverResult {
        self.limit_violation.get_or_insert((kind, limit, observed));
        Err(anyhow::anyhow!(
            "{kind:?} limit {limit} exceeded (observed {observed})"
        ))
    }
}

impl Observer for CosmeticInspectionObserver {
    fn interests(&self) -> Interests {
        Interests::DEMO_MESSAGE
            | Interests::SVC_MESSAGE
            | Interests::ENTITY_STATE
            | Interests::ENTITY_EVENTS
    }

    fn on_demo_command(
        &mut self,
        _ctx: &Context,
        _msg_type: EDemoCommands,
        _payload: &[u8],
    ) -> ObserverResult {
        let observed = self.demo_messages.saturating_add(1);
        if observed > self.limits.max_demo_messages {
            return self.fail_limit(
                LimitKind::DemoMessages,
                self.limits.max_demo_messages,
                observed,
            );
        }
        self.demo_messages = observed;
        Ok(())
    }

    fn on_svc_message(
        &mut self,
        _ctx: &Context,
        msg_type: SvcMessages,
        payload: &[u8],
    ) -> ObserverResult {
        if msg_type != SvcMessages::SvcPacketEntities {
            return Ok(());
        }
        let message = CSvcMsgPacketEntities::decode(payload)?;
        let updates = u64::try_from(message.updated_entries())
            .map_err(|_| anyhow::anyhow!("packet entity update count cannot be negative"))?;
        let observed = self.entity_updates.saturating_add(updates);
        if observed > self.limits.max_entity_updates {
            return self.fail_limit(
                LimitKind::EntityUpdates,
                self.limits.max_entity_updates,
                observed,
            );
        }
        self.entity_updates = observed;
        Ok(())
    }

    fn on_entity(
        &mut self,
        _ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> ObserverResult {
        if event == EntityEvents::Deleted {
            return Ok(());
        }
        let handle = entity.handle();
        if self.distinct_entities.insert(handle) {
            let observed = self.distinct_entities.len() as u64;
            if observed > self.limits.max_distinct_entities {
                return self.fail_limit(
                    LimitKind::DistinctEntities,
                    self.limits.max_distinct_entities,
                    observed,
                );
            }
        }
        let snapshot = snapshot_entity(entity);
        if candidate_from_snapshot(&snapshot).is_some() {
            self.snapshots.insert(handle, snapshot);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    owner: StablePlayerIdentity,
    item_definition_index: u16,
    match_basis: MatchBasis,
    handle: u32,
    class_name: String,
    paint_kit: Option<u32>,
    seed: Option<u32>,
    wear: Option<f32>,
    stat_trak: Option<u32>,
    incompatible_fields: BTreeSet<CosmeticField>,
}

fn candidate_from_snapshot(snapshot: &EntitySnapshot) -> Option<Candidate> {
    let account_id = numeric_u32(snapshot.fields.get(ACCOUNT_ID_PATH)?)?;
    if account_id == 0 {
        return None;
    }
    let item_definition_index =
        u16::try_from(numeric_u32(snapshot.fields.get(ITEM_DEFINITION_PATH)?)?)
            .ok()
            .filter(|value| *value != 0)?;

    let original_low = snapshot
        .fields
        .get(ORIGINAL_OWNER_LOW_PATH)
        .and_then(numeric_u32);
    let original_high = snapshot
        .fields
        .get(ORIGINAL_OWNER_HIGH_PATH)
        .and_then(numeric_u32);
    let original = original_low
        .zip(original_high)
        .map(|(low, high)| u64::from(low) | (u64::from(high) << 32));
    if original.is_some_and(|steam_id64| {
        u32::try_from(steam_id64 & u64::from(u32::MAX)).ok() != Some(account_id)
    }) {
        return None;
    }
    let (steam_id64, match_basis) = original.filter(|value| value >> 32 != 0).map_or_else(
        || {
            (
                STEAM_ID64_INDIVIDUAL_BASE.saturating_add(u64::from(account_id)),
                MatchBasis::AccountId,
            )
        },
        |value| (value, MatchBasis::Both),
    );
    let owner = StablePlayerIdentity::new(steam_id64, account_id).ok()?;

    let mut incompatible_fields = BTreeSet::new();
    let paint_kit = inspect_unsigned(snapshot, CosmeticField::PaintKit, &mut incompatible_fields);
    let seed = inspect_unsigned(snapshot, CosmeticField::Seed, &mut incompatible_fields);
    let stat_trak = inspect_unsigned(snapshot, CosmeticField::StatTrak, &mut incompatible_fields);
    let wear = match snapshot.fields.get(CosmeticField::Wear.schema_path()) {
        Some(CosmeticFieldValue::Float(value)) => Some(*value),
        Some(_) => {
            incompatible_fields.insert(CosmeticField::Wear);
            None
        }
        None => None,
    };
    if paint_kit.is_none()
        && seed.is_none()
        && wear.is_none()
        && stat_trak.is_none()
        && incompatible_fields.is_empty()
    {
        return None;
    }

    Some(Candidate {
        owner,
        item_definition_index,
        match_basis,
        handle: snapshot.handle,
        class_name: snapshot.class_name.clone(),
        paint_kit,
        seed,
        wear,
        stat_trak,
        incompatible_fields,
    })
}

fn numeric_u32(value: &CosmeticFieldValue) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn inspect_unsigned(
    snapshot: &EntitySnapshot,
    field: CosmeticField,
    incompatible: &mut BTreeSet<CosmeticField>,
) -> Option<u32> {
    let value = snapshot.fields.get(field.schema_path())?;
    let result = numeric_u32(value);
    if result.is_none() {
        incompatible.insert(field);
    }
    result
}

#[derive(Debug)]
struct ItemAccumulator {
    item: CosmeticInspectionItem,
    handles: BTreeSet<u32>,
    classes: BTreeSet<String>,
}

fn aggregate_items(snapshots: &[EntitySnapshot]) -> Vec<CosmeticInspectionItem> {
    let mut groups = BTreeMap::<(u64, u16), ItemAccumulator>::new();
    for candidate in snapshots.iter().filter_map(candidate_from_snapshot) {
        let key = (candidate.owner.steam_id64, candidate.item_definition_index);
        match groups.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                let handles = BTreeSet::from([candidate.handle]);
                let classes = BTreeSet::from([candidate.class_name.clone()]);
                entry.insert(ItemAccumulator {
                    item: CosmeticInspectionItem {
                        owner: candidate.owner,
                        item_definition_index: candidate.item_definition_index,
                        match_basis: candidate.match_basis,
                        entity_handles: Vec::new(),
                        class_names: Vec::new(),
                        paint_kit: candidate.paint_kit,
                        seed: candidate.seed,
                        wear: candidate.wear,
                        stat_trak: candidate.stat_trak,
                        incompatible_fields: candidate.incompatible_fields,
                        conflicting_fields: BTreeSet::new(),
                    },
                    handles,
                    classes,
                });
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                let accumulator = entry.get_mut();
                accumulator.handles.insert(candidate.handle);
                accumulator.classes.insert(candidate.class_name);
                accumulator
                    .item
                    .incompatible_fields
                    .extend(candidate.incompatible_fields);
                if candidate.match_basis == MatchBasis::Both {
                    accumulator.item.match_basis = MatchBasis::Both;
                }
                merge_value(
                    &mut accumulator.item.paint_kit,
                    candidate.paint_kit,
                    CosmeticField::PaintKit,
                    &mut accumulator.item.conflicting_fields,
                );
                merge_value(
                    &mut accumulator.item.seed,
                    candidate.seed,
                    CosmeticField::Seed,
                    &mut accumulator.item.conflicting_fields,
                );
                merge_value(
                    &mut accumulator.item.wear,
                    candidate.wear,
                    CosmeticField::Wear,
                    &mut accumulator.item.conflicting_fields,
                );
                merge_value(
                    &mut accumulator.item.stat_trak,
                    candidate.stat_trak,
                    CosmeticField::StatTrak,
                    &mut accumulator.item.conflicting_fields,
                );
            }
        }
    }
    groups
        .into_values()
        .map(|mut accumulator| {
            accumulator.item.entity_handles = accumulator.handles.into_iter().collect();
            accumulator.item.class_names = accumulator.classes.into_iter().collect();
            accumulator.item
        })
        .collect()
}

fn merge_value<T: Copy + PartialEq>(
    current: &mut Option<T>,
    next: Option<T>,
    field: CosmeticField,
    conflicts: &mut BTreeSet<CosmeticField>,
) {
    if *current != next {
        *current = None;
        conflicts.insert(field);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(value: u32) -> CosmeticFieldValue {
        CosmeticFieldValue::Unsigned32(value)
    }

    fn snapshot(handle: u32, paint_kit: u32) -> EntitySnapshot {
        let account_id = 123_456_u32;
        let steam_id64 = STEAM_ID64_INDIVIDUAL_BASE + u64::from(account_id);
        EntitySnapshot {
            handle,
            class_name: "CWeaponAK47".to_owned(),
            fields: BTreeMap::from([
                (ACCOUNT_ID_PATH.to_owned(), scalar(account_id)),
                (
                    ITEM_DEFINITION_PATH.to_owned(),
                    CosmeticFieldValue::Unsigned16(7),
                ),
                (
                    ORIGINAL_OWNER_LOW_PATH.to_owned(),
                    scalar(
                        u32::try_from(steam_id64 & u64::from(u32::MAX)).expect("low Steam ID bits"),
                    ),
                ),
                (
                    ORIGINAL_OWNER_HIGH_PATH.to_owned(),
                    scalar(u32::try_from(steam_id64 >> 32).expect("high Steam ID bits")),
                ),
                (
                    CosmeticField::PaintKit.schema_path().to_owned(),
                    scalar(paint_kit),
                ),
                (
                    CosmeticField::Wear.schema_path().to_owned(),
                    CosmeticFieldValue::Float(0.12),
                ),
            ]),
        }
    }

    #[test]
    fn groups_transient_handles_by_stable_owner_and_item() {
        let items = aggregate_items(&[snapshot(2, 600), snapshot(1, 600)]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].entity_handles, vec![1, 2]);
        assert_eq!(items[0].paint_kit, Some(600));
        assert_eq!(items[0].match_basis, MatchBasis::Both);
    }

    #[test]
    fn reports_conflicting_values_instead_of_guessing() {
        let items = aggregate_items(&[snapshot(1, 600), snapshot(2, 601)]);
        assert_eq!(items[0].paint_kit, None);
        assert!(
            items[0]
                .conflicting_fields
                .contains(&CosmeticField::PaintKit)
        );
    }

    #[test]
    fn rejects_conflicting_owner_identity() {
        let mut snapshot = snapshot(1, 600);
        snapshot
            .fields
            .insert(ORIGINAL_OWNER_LOW_PATH.to_owned(), scalar(999));
        assert!(candidate_from_snapshot(&snapshot).is_none());
    }
}
