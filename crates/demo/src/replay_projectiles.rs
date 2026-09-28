use std::collections::{BTreeMap, HashMap, HashSet};

use ahash::AHashMap;
use demoparser::{
    first_pass::{
        parser_settings::ParserInputs,
        prop_controller::{
            ENTITY_ID_ID, GRENADE_SERIAL_ID, GRENADE_TYPE_ID, GRENADE_X, GRENADE_Y, GRENADE_Z,
            STEAMID_ID, TICK_ID,
        },
    },
    parse_demo::{Parser, ParserResourceOptions, ParsingMode},
    second_pass::{parser_settings::create_huffman_lookup_table, variants::VarVec},
};
use vibe_cs_domain::{
    EventKind, REPLAY_MAX_EFFECT_RECORDS, ReplayProjectile, ReplayProjectilePhase, TimelineEvent,
};

use crate::{
    DemoError, DemoResult, ParseCancellation,
    demoparser_backend::{parser_decode_error, parser_resource_policy_error},
    replay_snapshots::{finite_at, string_at, unsigned_at},
};

#[derive(Debug)]
pub(crate) struct UtilityEvents {
    pub events: Vec<TimelineEvent>,
    pub freeze_ends: Vec<u64>,
}

pub(crate) fn read_utility_events(
    bytes: &[u8],
    tick_rate: f64,
    cancellation: &ParseCancellation,
) -> DemoResult<UtilityEvents> {
    use crate::demoparser_backend::{collect_player_identities, convert_event};
    use demoparser::first_pass::parser_settings::rm_user_friendly_names;
    let friendly = ["X", "Y", "Z"].map(str::to_owned).to_vec();
    let props =
        rm_user_friendly_names(&friendly).map_err(|error| DemoError::Parse(error.to_string()))?;
    let huffman = create_huffman_lookup_table();
    let inputs = ParserInputs {
        real_name_to_og_name: props.iter().cloned().zip(friendly).collect(),
        wanted_player_props: props,
        wanted_players: Vec::new(),
        wanted_ticks: Vec::new(),
        wanted_other_props: Vec::new(),
        wanted_prop_states: AHashMap::default(),
        wanted_events: [
            "round_freeze_end",
            "smokegrenade_detonate",
            "smokegrenade_expired",
            "hegrenade_detonate",
            "flashbang_detonate",
            "inferno_startburn",
            "inferno_expire",
            "decoy_started",
            "decoy_detonate",
            "bomb_planted",
            "bomb_defused",
            "bomb_exploded",
        ]
        .map(str::to_owned)
        .to_vec(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: &huffman,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };
    let mut parser = Parser::with_resource_options(
        inputs,
        ParsingMode::Normal,
        ParserResourceOptions {
            max_game_events: 100_000,
            max_collected_rows: 0,
            ..ParserResourceOptions::default()
        },
    )
    .map_err(parser_resource_policy_error)?;
    let output = parser.parse_demo(bytes).map_err(parser_decode_error)?;
    cancellation.check()?;
    let identities = collect_player_identities(
        &output.player_md,
        &output.roster,
        &output.game_events,
        &output.player_userids,
    );
    let mut result = UtilityEvents {
        events: Vec::new(),
        freeze_ends: Vec::new(),
    };
    for (sequence, event) in output.game_events.into_iter().enumerate() {
        if event.name == "round_freeze_end" {
            if let Ok(tick) = u64::try_from(event.tick) {
                result.freeze_ends.push(tick);
            }
            continue;
        }
        let kind = match event.name.as_str() {
            "bomb_planted" => EventKind::BombPlant,
            "bomb_defused" => EventKind::BombDefuse,
            "bomb_exploded" => EventKind::BombExplode,
            _ => EventKind::Grenade,
        };
        let raw = convert_event(sequence as u64, event);
        result.events.push(crate::engine::timeline_event(
            &raw,
            kind,
            tick_rate,
            &identities,
        ));
    }
    Ok(result)
}

#[derive(Debug)]
struct Sample {
    tick: u64,
    entity: u64,
    serial: u64,
    owner: Option<String>,
    kind: String,
    position: [f64; 3],
}

pub(crate) fn read_projectiles(
    bytes: &[u8],
    ticks: &[u64],
    events: &[TimelineEvent],
    cancellation: &ParseCancellation,
) -> DemoResult<BTreeMap<u64, Vec<ReplayProjectile>>> {
    let samples = collect_samples(bytes, ticks, cancellation, REPLAY_MAX_EFFECT_RECORDS)?;
    materialize(samples, events)
}

fn collect_samples(
    bytes: &[u8],
    ticks: &[u64],
    cancellation: &ParseCancellation,
    maximum_rows: usize,
) -> DemoResult<Vec<Sample>> {
    cancellation.check()?;
    let huffman = create_huffman_lookup_table();
    let inputs = ParserInputs {
        real_name_to_og_name: AHashMap::default(),
        wanted_player_props: Vec::new(),
        wanted_players: Vec::new(),
        wanted_ticks: ticks
            .iter()
            .map(|tick| {
                i32::try_from(*tick).map_err(|_| {
                    DemoError::Parse("projectile tick exceeds parser range".to_owned())
                })
            })
            .collect::<DemoResult<_>>()?,
        wanted_other_props: Vec::new(),
        wanted_prop_states: AHashMap::default(),
        wanted_events: Vec::new(),
        parse_ents: true,
        parse_projectiles: true,
        parse_grenades: true,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: &huffman,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };
    let mut parser = Parser::with_resource_options(
        inputs,
        ParsingMode::Normal,
        ParserResourceOptions {
            max_game_events: 100_000,
            max_collected_rows: maximum_rows,
            ..ParserResourceOptions::default()
        },
    )
    .map_err(parser_resource_policy_error)?;
    let output = parser.parse_demo(bytes).map_err(parser_decode_error)?;
    cancellation.check()?;
    let Some(VarVec::I32(observed_ticks)) = output
        .df
        .get(&TICK_ID)
        .and_then(|column| column.data.as_ref())
    else {
        return Ok(Vec::new());
    };
    let requested = ticks.iter().copied().collect::<HashSet<_>>();
    let mut samples = Vec::new();
    for index in 0..observed_ticks.len() {
        let Some(tick) =
            unsigned_at(output.df.get(&TICK_ID), index).filter(|tick| requested.contains(tick))
        else {
            continue;
        };
        let Some(class) = string_at(output.df.get(&GRENADE_TYPE_ID), index)
            .filter(|class| class.contains("Projectile"))
        else {
            continue;
        };
        let entity = unsigned_at(output.df.get(&ENTITY_ID_ID), index)
            .ok_or_else(|| DemoError::Parse("projectile entity id is absent".to_owned()))?;
        let serial = unsigned_at(output.df.get(&GRENADE_SERIAL_ID), index)
            .ok_or_else(|| DemoError::Parse("projectile entity serial is absent".to_owned()))?;
        let position = [
            finite_at(output.df.get(&GRENADE_X), index)?,
            finite_at(output.df.get(&GRENADE_Y), index)?,
            finite_at(output.df.get(&GRENADE_Z), index)?,
        ];
        if position.iter().any(|value| value.abs() > 1_000_000.0) {
            return Err(DemoError::Parse(
                "projectile coordinate is outside world bounds".to_owned(),
            ));
        }
        let owner = unsigned_at(output.df.get(&STEAMID_ID), index)
            .filter(|id| *id != 0)
            .map(|id| id.to_string());
        samples.push(Sample {
            tick,
            entity,
            serial,
            owner,
            kind: projectile_kind(class).to_owned(),
            position,
        });
    }
    samples.sort_unstable_by_key(|sample| (sample.entity, sample.serial, sample.tick));
    Ok(samples)
}

fn projectile_kind(class: &str) -> &'static str {
    if class.contains("Smoke") {
        "smoke"
    } else if class.contains("Flash") {
        "flash"
    } else if class.contains("HEGrenade") {
        "he"
    } else if class.contains("Molotov") || class.contains("Incendiary") {
        "inferno"
    } else if class.contains("Decoy") {
        "decoy"
    } else {
        "grenade"
    }
}

fn materialize(
    samples: Vec<Sample>,
    events: &[TimelineEvent],
) -> DemoResult<BTreeMap<u64, Vec<ReplayProjectile>>> {
    let mut detonations = HashMap::<u64, Vec<u64>>::new();
    for event in events {
        if (event.id.starts_with("smokegrenade_detonate-")
            || event.id.starts_with("flashbang_detonate-")
            || event.id.starts_with("hegrenade_detonate-")
            || event.id.starts_with("decoy_started-"))
            && let Some(entity) = event
                .detail
                .get("entityid")
                .and_then(serde_json::Value::as_u64)
        {
            detonations.entry(entity).or_default().push(event.tick);
        }
    }
    let mut lifetimes = HashMap::<(u64, u64), (u64, u64)>::new();
    let mut unique = HashSet::new();
    for sample in &samples {
        if !unique.insert((sample.entity, sample.serial, sample.tick)) {
            return Err(DemoError::Parse("duplicate projectile snapshot".to_owned()));
        }
        let entry = lifetimes
            .entry((sample.entity, sample.serial))
            .or_insert((sample.tick, sample.tick));
        entry.0 = entry.0.min(sample.tick);
        entry.1 = entry.1.max(sample.tick);
    }
    for ((entity, _), (start, end)) in &mut lifetimes {
        if let Some(tick) = detonations.get(entity).and_then(|ticks| {
            ticks
                .iter()
                .filter(|tick| **tick >= *start && **tick <= *end)
                .min()
        }) {
            *end = tick.saturating_sub(1);
        }
    }
    let mut frames = BTreeMap::<u64, Vec<ReplayProjectile>>::new();
    for sample in samples {
        let (start_tick, end_tick) = lifetimes[&(sample.entity, sample.serial)];
        if sample.tick > end_tick {
            continue;
        }
        frames
            .entry(sample.tick)
            .or_default()
            .push(ReplayProjectile {
                id: format!("projectile:{}:{}", sample.entity, sample.serial),
                owner_id: sample.owner,
                kind: sample.kind,
                phase: ReplayProjectilePhase::Flying,
                start_tick,
                end_tick,
                position: sample.position,
                active: true,
                radius: None,
                masks_vision: false,
            });
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(tick: u64, serial: u64) -> Sample {
        Sample {
            tick,
            entity: 42,
            serial,
            owner: Some("76561198000000000".to_owned()),
            kind: "smoke".to_owned(),
            position: [0.0; 3],
        }
    }

    #[test]
    fn reused_entity_slots_remain_distinct_trajectories() {
        let frames = materialize(
            vec![sample(8, 1), sample(16, 1), sample(24, 2), sample(32, 2)],
            &[],
        )
        .unwrap();
        assert_eq!(frames[&8][0].id, frames[&16][0].id);
        assert_ne!(frames[&16][0].id, frames[&24][0].id);
        assert_eq!(
            (frames[&24][0].start_tick, frames[&24][0].end_tick),
            (24, 32)
        );
        assert!(materialize(vec![sample(8, 1), sample(8, 1)], &[]).is_err());
    }

    #[test]
    #[ignore = "requires VIBE_CS_REAL_DEMO_DIR"]
    fn real_projectile_collection_obeys_the_shared_zero_row_budget() {
        let root = std::path::PathBuf::from(std::env::var_os("VIBE_CS_REAL_DEMO_DIR").unwrap());
        let bytes = std::fs::read(root.join("furia-vs-falcons-m1-mirage.dem")).unwrap();
        let error = collect_samples(&bytes, &[50_000, 60_000], &ParseCancellation::default(), 0)
            .unwrap_err();
        assert!(
            matches!(error, DemoError::ParserResourceLimit { .. }),
            "{error}"
        );
    }
}
