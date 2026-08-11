use std::collections::{BTreeMap, HashSet};
use std::io::SeekFrom;
use std::thread;

use source2_demo::proto::{CSvcMsgPacketEntities, Message, SvcMessages};
use source2_demo::writer::{
    DemoRewriter, DemoWriter, MessageRewrite, ParserError, RewriteInterests,
};
use source2_demo::{Context, Entity, EntityEvents, FieldValue};

use crate::backend::{DemoRewriteBackend, ReadSeek, WriteSeek};
use crate::plan::plan_validated_entity_rewrite;
use crate::{
    ACCOUNT_ID_PATH, BackendError, BackendReport, CosmeticField, CosmeticFieldValue,
    EntitySnapshot, FieldHit, ITEM_DEFINITION_PATH, LimitKind, ORIGINAL_OWNER_HIGH_PATH,
    ORIGINAL_OWNER_LOW_PATH, PatchRewriteReport, RewriteLimits, RewriteRequest,
};

pub(crate) const INSPECTED_PATHS: [&str; 8] = [
    ACCOUNT_ID_PATH,
    ITEM_DEFINITION_PATH,
    ORIGINAL_OWNER_LOW_PATH,
    ORIGINAL_OWNER_HIGH_PATH,
    CosmeticField::PaintKit.schema_path(),
    CosmeticField::Seed.schema_path(),
    CosmeticField::Wear.schema_path(),
    CosmeticField::StatTrak.schema_path(),
];
const SOURCE2_WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

/// Production backend powered only by the public `source2-demo` writer API.
#[derive(Debug, Default, Clone, Copy)]
pub struct Source2RewriteBackend;

#[derive(Debug)]
struct LimitViolation {
    kind: LimitKind,
    limit: u64,
    observed: u64,
}

#[derive(Debug)]
struct PatchCounters {
    matched_entities: HashSet<u32>,
    hits: [u64; 4],
    incompatible_type_occurrences: u64,
}

impl PatchCounters {
    fn new() -> Self {
        Self {
            matched_entities: HashSet::new(),
            hits: [0; 4],
            incompatible_type_occurrences: 0,
        }
    }
}

#[derive(Debug)]
struct CosmeticEntityRewriter {
    request: RewriteRequest,
    limits: RewriteLimits,
    entity_updates: u64,
    distinct_entities: HashSet<u32>,
    patches: Vec<PatchCounters>,
    limit_violation: Option<LimitViolation>,
}

impl CosmeticEntityRewriter {
    fn new(request: RewriteRequest, limits: RewriteLimits) -> Self {
        let patches = request
            .patches
            .iter()
            .map(|_| PatchCounters::new())
            .collect();
        Self {
            request,
            limits,
            entity_updates: 0,
            distinct_entities: HashSet::new(),
            patches,
            limit_violation: None,
        }
    }

    fn set_limit(&mut self, kind: LimitKind, limit: u64, observed: u64) {
        self.limit_violation.get_or_insert(LimitViolation {
            kind,
            limit,
            observed,
        });
    }

    fn parser_limit_error(&self) -> ParserError {
        self.limit_violation.as_ref().map_or_else(
            || anyhow::anyhow!("rewrite limit exceeded without counter evidence").into(),
            |violation| {
                anyhow::anyhow!(
                    "{:?} limit {} exceeded (observed {})",
                    violation.kind,
                    violation.limit,
                    violation.observed
                )
                .into()
            },
        )
    }

    fn into_report(self) -> BackendReport {
        let patches = self
            .request
            .patches
            .iter()
            .zip(self.patches)
            .enumerate()
            .map(|(patch_index, (patch, counters))| PatchRewriteReport {
                patch_index,
                matched_entities: counters.matched_entities.len() as u64,
                field_hits: CosmeticField::ALL
                    .into_iter()
                    .filter(|field| patch.values.requested(*field))
                    .map(|field| FieldHit {
                        field,
                        hits: counters.hits[field.index()],
                    })
                    .collect(),
                incompatible_type_occurrences: counters.incompatible_type_occurrences,
            })
            .collect();
        BackendReport {
            entity_updates: self.entity_updates,
            distinct_entities: self.distinct_entities.len() as u64,
            patches,
        }
    }
}

impl DemoRewriter for CosmeticEntityRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE | RewriteInterests::ENTITY_FIELDS
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        if self.limit_violation.is_some() {
            return Err(self.parser_limit_error());
        }
        if msg_type != SvcMessages::SvcPacketEntities as i32 {
            return Ok(MessageRewrite::Keep);
        }

        let message = CSvcMsgPacketEntities::decode(payload)?;
        let updates = u64::try_from(message.updated_entries()).map_err(|_| {
            ParserError::ObserverError(anyhow::anyhow!(
                "packet entity update count cannot be negative"
            ))
        })?;
        let observed = self.entity_updates.saturating_add(updates);
        if observed > self.limits.max_entity_updates {
            self.set_limit(
                LimitKind::EntityUpdates,
                self.limits.max_entity_updates,
                observed,
            );
            return Err(self.parser_limit_error());
        }
        self.entity_updates = observed;
        Ok(MessageRewrite::Keep)
    }

    fn should_rewrite_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        if self.limit_violation.is_some() {
            return false;
        }
        let handle = entity.handle();
        if !self.distinct_entities.contains(&handle) {
            let observed = self.distinct_entities.len() as u64 + 1;
            if observed > self.limits.max_distinct_entities {
                self.set_limit(
                    LimitKind::DistinctEntities,
                    self.limits.max_distinct_entities,
                    observed,
                );
                return false;
            }
            self.distinct_entities.insert(handle);
        }
        true
    }

    fn should_track_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        _entity: &Entity,
    ) -> bool {
        true
    }

    fn replace_entity_field(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        _value: &FieldValue,
    ) -> Option<FieldValue> {
        let field = CosmeticField::from_schema_path(field_name)?;
        if self.limit_violation.is_some() {
            return None;
        }

        let snapshot = snapshot_entity(entity);
        let plan = plan_validated_entity_rewrite(&snapshot, &self.request);
        let patch_index = plan.patch_index?;
        let counters = &mut self.patches[patch_index];
        counters.matched_entities.insert(entity.handle());
        if plan.incompatible_fields.contains(&field) {
            counters.incompatible_type_occurrences =
                counters.incompatible_type_occurrences.saturating_add(1);
            return None;
        }
        let replacement = plan
            .replacements
            .iter()
            .find(|replacement| replacement.field == field)?;
        let replacement = to_source_value(&replacement.replacement)?;
        counters.hits[field.index()] = counters.hits[field.index()].saturating_add(1);
        Some(replacement)
    }
}

impl DemoRewriteBackend for Source2RewriteBackend {
    fn rewrite(
        &self,
        input: &mut dyn ReadSeek,
        output: &mut dyn WriteSeek,
        request: &RewriteRequest,
        limits: &RewriteLimits,
    ) -> Result<BackendReport, BackendError> {
        thread::scope(|scope| {
            let worker = thread::Builder::new()
                .name("vibe-cs-cosmetics-writer".to_owned())
                .stack_size(SOURCE2_WORKER_STACK_BYTES)
                .spawn_scoped(scope, move || {
                    rewrite_source2_stream(input, output, request, limits)
                })
                .map_err(|error| BackendError::Io(error.to_string()))?;
            worker
                .join()
                .map_err(|_| BackendError::Stream("Source 2 rewrite worker panicked".to_owned()))?
        })
    }
}

fn rewrite_source2_stream(
    input: &mut dyn ReadSeek,
    output: &mut dyn WriteSeek,
    request: &RewriteRequest,
    limits: &RewriteLimits,
) -> Result<BackendReport, BackendError> {
    input
        .seek(SeekFrom::Start(0))
        .map_err(|error| BackendError::Io(error.to_string()))?;
    let mut writer = DemoWriter::from_reader(&mut *input, &mut *output)
        .map_err(|error| BackendError::Stream(error.to_string()))?;
    let state = writer.add_rewriter(CosmeticEntityRewriter::new(request.clone(), *limits));
    let run_result = writer.run();
    drop(writer);

    let mut state = state.borrow_mut();
    if let Some(violation) = state.limit_violation.take() {
        return Err(BackendError::LimitExceeded {
            kind: violation.kind,
            limit: violation.limit,
            observed: violation.observed,
        });
    }
    run_result.map_err(|error| BackendError::Stream(error.to_string()))?;
    let state = std::mem::replace(
        &mut *state,
        CosmeticEntityRewriter::new(request.clone(), *limits),
    );
    Ok(state.into_report())
}

pub(crate) fn snapshot_entity(entity: &Entity) -> EntitySnapshot {
    let fields = INSPECTED_PATHS
        .into_iter()
        .filter_map(|path| {
            entity
                .get_property(path)
                .ok()
                .map(|value| (path.to_owned(), from_source_value(value)))
        })
        .collect::<BTreeMap<_, _>>();
    EntitySnapshot {
        handle: entity.handle(),
        class_name: entity.class().name().to_owned(),
        fields,
    }
}

fn from_source_value(value: &FieldValue) -> CosmeticFieldValue {
    match value {
        FieldValue::Signed8(value) => CosmeticFieldValue::Signed8(*value),
        FieldValue::Signed16(value) => CosmeticFieldValue::Signed16(*value),
        FieldValue::Signed32(value) => CosmeticFieldValue::Signed32(*value),
        FieldValue::Signed64(value) => CosmeticFieldValue::Signed64(*value),
        FieldValue::Unsigned8(value) => CosmeticFieldValue::Unsigned8(*value),
        FieldValue::Unsigned16(value) => CosmeticFieldValue::Unsigned16(*value),
        FieldValue::Unsigned32(value) => CosmeticFieldValue::Unsigned32(*value),
        FieldValue::Unsigned64(value) => CosmeticFieldValue::Unsigned64(*value),
        FieldValue::Float(value) => CosmeticFieldValue::Float(*value),
        other => CosmeticFieldValue::Unsupported(other.type_name().to_owned()),
    }
}

fn to_source_value(value: &CosmeticFieldValue) -> Option<FieldValue> {
    match value {
        CosmeticFieldValue::Signed8(value) => Some(FieldValue::Signed8(*value)),
        CosmeticFieldValue::Signed16(value) => Some(FieldValue::Signed16(*value)),
        CosmeticFieldValue::Signed32(value) => Some(FieldValue::Signed32(*value)),
        CosmeticFieldValue::Signed64(value) => Some(FieldValue::Signed64(*value)),
        CosmeticFieldValue::Unsigned8(value) => Some(FieldValue::Unsigned8(*value)),
        CosmeticFieldValue::Unsigned16(value) => Some(FieldValue::Unsigned16(*value)),
        CosmeticFieldValue::Unsigned32(value) => Some(FieldValue::Unsigned32(*value)),
        CosmeticFieldValue::Unsigned64(value) => Some(FieldValue::Unsigned64(*value)),
        CosmeticFieldValue::Float(value) => Some(FieldValue::Float(*value)),
        CosmeticFieldValue::Unsupported(_) => None,
    }
}
