//! One selected-tick player snapshot reader for whole-match and round replay.
use std::collections::HashSet;

use ahash::AHashMap;
use demoparser::{
    first_pass::{
        parser_settings::{ParserInputs, rm_user_friendly_names},
        prop_controller::TICK_ID,
    },
    parse_demo::{Parser, ParserResourceOptions, ParsingMode},
    second_pass::{
        parser_settings::create_huffman_lookup_table,
        variants::{PropColumn, VarVec},
    },
};
use vibe_cs_domain::ReplayInputState;

use crate::{
    DemoError, DemoResult, ParseCancellation,
    demoparser_backend::{parser_decode_error, parser_resource_policy_error},
};

const PROPERTIES: [&str; 15] = [
    "X",
    "Y",
    "Z",
    "yaw",
    "pitch",
    "health",
    "armor",
    "life_state",
    "team_num",
    "balance",
    "current_equip_value",
    "round_start_equip_value",
    "has_helmet",
    "active_weapon_name",
    "buttons",
];

#[derive(Debug)]
pub(crate) struct PlayerSnapshot {
    pub steam_id: u64,
    pub tick: u64,
    pub side: &'static str,
    pub position: [f64; 3],
    pub yaw: f64,
    pub pitch: f64,
    pub health: u32,
    pub armor: u32,
    pub life_state: u32,
    pub money: u32,
    pub current_equipment_value: u32,
    pub round_start_equipment_value: u32,
    pub has_helmet: bool,
    pub active_weapon_name: Option<String>,
    pub input: Option<ReplayInputState>,
}

pub(crate) fn select_snapshot_ticks(bytes: &[u8], requested: &[u64]) -> DemoResult<Vec<u64>> {
    let packets = demoparser::first_pass::frameparser::FrameParser::packet_ticks(bytes, 2_000_000)
        .map_err(parser_decode_error)?;
    let Some((start, end)) = requested.first().zip(requested.last()) else {
        return Ok(Vec::new());
    };
    let available = packets
        .into_iter()
        .filter_map(|tick| u64::try_from(tick).ok())
        .filter(|tick| (*start..=*end).contains(tick))
        .collect::<Vec<_>>();
    let mut selected = std::collections::BTreeSet::new();
    for tick in requested {
        let next = available.partition_point(|candidate| candidate < tick);
        let candidate = [
            next.checked_sub(1).and_then(|index| available.get(index)),
            available.get(next),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|candidate| candidate.abs_diff(*tick));
        let Some(candidate) = candidate.filter(|candidate| candidate.abs_diff(*tick) <= 16) else {
            return Err(DemoError::Unavailable {
                capability: "replay",
                reason: format!("no actual Demo packet within 16 ticks of sample {tick}"),
            });
        };
        selected.insert(*candidate);
    }
    Ok(selected.into_iter().collect())
}

pub(crate) fn read_player_snapshots(
    bytes: &[u8],
    ticks: &[u64],
    players: &[u64],
    cancellation: &ParseCancellation,
    maximum_rows: usize,
) -> DemoResult<Vec<PlayerSnapshot>> {
    cancellation.check()?;
    let friendly = PROPERTIES.map(str::to_owned).to_vec();
    let properties = rm_user_friendly_names(&friendly)
        .map_err(|error| DemoError::Parse(format!("replay properties: {error}")))?;
    let huffman = create_huffman_lookup_table();
    let inputs = ParserInputs {
        real_name_to_og_name: properties.iter().cloned().zip(friendly).collect(),
        wanted_player_props: properties,
        wanted_players: players.to_vec(),
        wanted_ticks: ticks
            .iter()
            .map(|tick| {
                i32::try_from(*tick)
                    .map_err(|_| DemoError::Parse("replay tick exceeds parser range".to_owned()))
            })
            .collect::<DemoResult<_>>()?,
        wanted_other_props: Vec::new(),
        wanted_prop_states: AHashMap::default(),
        wanted_events: Vec::new(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: &huffman,
        order_by_steamid: true,
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
    let mut ids = Vec::with_capacity(PROPERTIES.len());
    for name in PROPERTIES {
        ids.push(
            output
                .prop_controller
                .prop_infos
                .iter()
                .find(|info| info.prop_friendly_name == name)
                .map(|info| info.id)
                .ok_or_else(|| DemoError::Parse(format!("replay property {name} is absent")))?,
        );
    }
    let requested = ticks.iter().copied().collect::<HashSet<_>>();
    let mut snapshots = Vec::new();
    for (steam_id, columns) in &output.df_per_player {
        if *steam_id == 0 {
            continue;
        }
        let Some(VarVec::I32(observed_ticks)) = columns
            .get(&TICK_ID)
            .and_then(|column| column.data.as_ref())
        else {
            return Err(DemoError::Parse("replay tick column is absent".to_owned()));
        };
        for (index, tick) in observed_ticks.iter().enumerate() {
            let Some(tick) = tick.and_then(|tick| u64::try_from(tick).ok()) else {
                continue;
            };
            if !requested.contains(&tick) {
                continue;
            }
            let column = |property: usize| columns.get(&ids[property]);
            let side = match integer_at(column(8), index) {
                Some(2) => "T",
                Some(3) => "CT",
                _ => continue,
            };
            let number = |property: usize| {
                finite_at(column(property), index).map_err(|_| {
                    DemoError::Parse(format!(
                        "{} is absent for {steam_id} at tick {tick}",
                        PROPERTIES[property]
                    ))
                })
            };
            let position = [number(0)?, number(1)?, number(2)?];
            let yaw = number(3)?;
            let pitch = number(4)?;
            if position.iter().any(|value| value.abs() > 1_000_000.0)
                || yaw.abs() > 360.0
                || pitch.abs() > 360.0
            {
                return Err(DemoError::Parse(
                    "replay snapshot is outside spatial bounds".to_owned(),
                ));
            }
            let bounded = |property, maximum| {
                integer_at(column(property), index)
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| *value <= maximum)
                    .ok_or_else(|| {
                        DemoError::Parse(format!(
                            "{} is absent or invalid for {steam_id} at tick {tick}",
                            PROPERTIES[property]
                        ))
                    })
            };
            let active_weapon_name = string_at(column(13), index)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if active_weapon_name
                .as_ref()
                .is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control))
            {
                return Err(DemoError::Parse("invalid replay weapon name".to_owned()));
            }
            snapshots.push(PlayerSnapshot {
                steam_id: *steam_id,
                tick,
                side,
                position,
                yaw,
                pitch,
                health: bounded(5, 200)?,
                armor: bounded(6, 200)?,
                life_state: bounded(7, 255)?,
                money: bounded(9, 100_000)?,
                current_equipment_value: bounded(10, 100_000)?,
                round_start_equipment_value: bounded(11, 100_000)?,
                has_helmet: bool_at(column(12), index)?,
                active_weapon_name,
                input: unsigned_at(column(14), index).map(input_from_mask),
            });
        }
    }
    snapshots.sort_unstable_by_key(|snapshot| (snapshot.tick, snapshot.steam_id));
    if snapshots
        .windows(2)
        .any(|pair| pair[0].tick == pair[1].tick && pair[0].steam_id == pair[1].steam_id)
    {
        return Err(DemoError::Parse(
            "duplicate selected-tick player snapshot".to_owned(),
        ));
    }
    Ok(snapshots)
}

pub(crate) fn input_from_mask(mask: u64) -> ReplayInputState {
    let bit = |index: u32| mask & (1_u64 << index) != 0_u64;
    ReplayInputState {
        forward: bit(3),
        left: bit(9),
        backward: bit(4),
        right: bit(10),
        jump: bit(1),
        crouch: bit(2),
        walk: bit(17) || bit(18),
        reload: bit(13),
        fire: bit(0),
        secondary_fire: bit(11),
    }
}

pub(crate) fn unsigned_at(column: Option<&PropColumn>, index: usize) -> Option<u64> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::U64(values)) => values.get(index).copied().flatten(),
        Some(VarVec::U32(values)) => values.get(index).copied().flatten().map(u64::from),
        Some(VarVec::I32(values)) => values
            .get(index)
            .copied()
            .flatten()
            .and_then(|value| u64::try_from(value).ok()),
        _ => None,
    }
}

pub(crate) fn integer_at(column: Option<&PropColumn>, index: usize) -> Option<i64> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::I32(values)) => values.get(index).copied().flatten().map(i64::from),
        _ => unsigned_at(column, index).and_then(|value| i64::try_from(value).ok()),
    }
}

pub(crate) fn finite_at(column: Option<&PropColumn>, index: usize) -> DemoResult<f64> {
    let value = match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::F32(values)) => values.get(index).copied().flatten().map(f64::from),
        Some(VarVec::I32(values)) => values.get(index).copied().flatten().map(f64::from),
        Some(VarVec::U32(values)) => values.get(index).copied().flatten().map(f64::from),
        _ => None,
    };
    value
        .filter(|value| value.is_finite())
        .ok_or_else(|| DemoError::Parse("required replay numeric field is absent".to_owned()))
}

pub(crate) fn string_at(column: Option<&PropColumn>, index: usize) -> Option<&str> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::String(values)) => values.get(index)?.as_deref(),
        _ => None,
    }
}

fn bool_at(column: Option<&PropColumn>, index: usize) -> DemoResult<bool> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::Bool(values)) => values
            .get(index)
            .copied()
            .flatten()
            .ok_or_else(|| DemoError::Parse("required replay boolean is absent".to_owned())),
        _ => Err(DemoError::Parse(
            "required replay boolean is absent".to_owned(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packets(ticks: &[u8]) -> Vec<u8> {
        let mut bytes = b"PBDEMS2\0".to_vec();
        bytes.resize(16, 0);
        for tick in ticks {
            bytes.extend([7, *tick, 1, 0]);
        }
        bytes.extend([0, 100, 0]);
        bytes
    }
    #[test]
    fn nominal_ticks_align_to_real_packets_and_large_holes_stay_explicit() {
        assert_eq!(
            select_snapshot_ticks(&packets(&[10, 12]), &[10, 11, 12]).unwrap(),
            [10, 12]
        );
        assert!(select_snapshot_ticks(&packets(&[10, 90]), &[10, 50, 90]).is_err());
    }
}
