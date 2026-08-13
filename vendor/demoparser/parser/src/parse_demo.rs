use crate::first_pass::parser::FirstPassOutput;
use crate::first_pass::parser_settings::check_multithreadability;
use crate::first_pass::parser_settings::{FirstPassParser, ParserInputs};
use crate::first_pass::prop_controller::{PropController, NAME_ID, STEAMID_ID, TICK_ID};
use crate::first_pass::read_bits::DemoParserError;
use crate::second_pass::collect_data::ProjectileRecord;
use crate::second_pass::game_events::{EventField, GameEvent};
use crate::second_pass::parser::SecondPassOutput;
use crate::second_pass::parser_settings::*;
use crate::second_pass::variants::VarVec;
use crate::second_pass::variants::{PropColumn, Variant};
use ahash::AHashMap;
use ahash::AHashSet;
use csgoproto::CsvcMsgVoiceData;
use itertools::Itertools;
use rayon::iter::IntoParallelIterator;
use rayon::iter::IntoParallelRefIterator;
use rayon::prelude::ParallelIterator;
use rayon::{ThreadPool, ThreadPoolBuilder};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

pub const HEADER_ENDS_AT_BYTE: usize = 16;

#[derive(Debug)]
pub struct DemoOutput {
    pub df: AHashMap<u32, PropColumn>,
    pub game_events: Vec<GameEvent>,
    pub skins: Vec<EconItem>,
    pub item_drops: Vec<EconItem>,
    pub chat_messages: Vec<ChatMessageRecord>,
    pub convars: AHashMap<String, String>,
    pub header: Option<AHashMap<String, String>>,
    pub player_md: Vec<PlayerEndMetaData>,
    /// Live player roster from CCSPlayerController entities (final per-player state,
    /// deduplicated by steamid). Populated even when the end-of-match scoreboard message
    /// is absent (community/casual demos). Fallback when `player_md` is empty.
    pub roster: Vec<PlayerEndMetaData>,
    /// `CMsgPlayerInfo.userid` low bytes keyed by SteamID. A `None` value is
    /// retained when one SteamID had conflicting user IDs.
    pub player_userids: BTreeMap<u64, Option<i32>>,
    pub game_events_counter: AHashSet<String>,
    pub uniq_prop_names: Vec<String>,
    pub projectiles: Vec<ProjectileRecord>,
    pub voice_data: Vec<(i32, CsvcMsgVoiceData)>,
    pub prop_controller: PropController,
    pub df_per_player: AHashMap<u64, AHashMap<u32, PropColumn>>,
}

pub struct Parser<'a> {
    input: ParserInputs<'a>,
    pub parsing_mode: ParsingMode,
    rayon_pool: Arc<ThreadPool>,
    resource_options: ParserResourceOptions,
}
#[derive(PartialEq)]
pub enum ParsingMode {
    ForceSingleThreaded,
    ForceMultiThreaded,
    Normal,
}

pub const MAX_PARSER_THREADS: usize = 16;
pub const DEFAULT_MAX_PARSER_THREADS: usize = 8;
pub const HUFFMAN_LOOKUP_TABLE_LEN: usize = 1 << 17;
pub const DEFAULT_MAX_FULLPACKET_SEGMENTS: usize = 4_096;
pub const DEFAULT_MAX_GAME_EVENTS: usize = 1_000_000;
pub const DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_MAX_STRING_TABLE_BYTES: usize = 128 * 1024 * 1024;
pub const DEFAULT_MAX_VOICE_DATA_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_MAX_INVENTORY_DATA_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_MAX_COLLECTED_ROWS: usize = 2_000_000;
pub const MAX_FULLPACKET_SEGMENTS: usize = 4_096;
pub const MAX_GAME_EVENTS: usize = 4_000_000;
pub const MAX_DECOMPRESSED_FRAME_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_STRING_TABLE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_VOICE_DATA_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_INVENTORY_DATA_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_COLLECTED_ROWS: usize = 4_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserResourceOptions {
    pub rayon_threads: usize,
    pub max_fullpacket_segments: usize,
    pub max_game_events: usize,
    pub max_decompressed_frame_bytes: usize,
    pub max_string_table_bytes: usize,
    pub parse_voice: bool,
    pub max_voice_data_bytes: usize,
    pub max_inventory_data_bytes: usize,
    pub max_collected_rows: usize,
}

impl Default for ParserResourceOptions {
    fn default() -> Self {
        let available = std::thread::available_parallelism().map(usize::from).unwrap_or(1);
        Self {
            rayon_threads: available.min(DEFAULT_MAX_PARSER_THREADS),
            max_fullpacket_segments: DEFAULT_MAX_FULLPACKET_SEGMENTS,
            max_game_events: DEFAULT_MAX_GAME_EVENTS,
            max_decompressed_frame_bytes: DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES,
            max_string_table_bytes: DEFAULT_MAX_STRING_TABLE_BYTES,
            parse_voice: false,
            max_voice_data_bytes: DEFAULT_MAX_VOICE_DATA_BYTES,
            max_inventory_data_bytes: DEFAULT_MAX_INVENTORY_DATA_BYTES,
            max_collected_rows: DEFAULT_MAX_COLLECTED_ROWS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParserResourceError {
    InvalidThreadCount { requested: usize, maximum: usize },
    InvalidResourceLimit { resource: &'static str, requested: usize, maximum: usize },
    InvalidHuffmanTableLength { expected: usize, actual: usize },
    ThreadPoolBuild(String),
}

impl fmt::Display for ParserResourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreadCount { requested, maximum } => write!(formatter, "parser thread count must be between 1 and {maximum}, got {requested}"),
            Self::ThreadPoolBuild(message) => {
                write!(formatter, "unable to build parser thread pool: {message}")
            }
            Self::InvalidResourceLimit { resource, requested, maximum } => {
                write!(formatter, "parser {resource} limit must be between 1 and {maximum}, got {requested}")
            }
            Self::InvalidHuffmanTableLength { expected, actual } => {
                write!(formatter, "parser Huffman lookup table must contain {expected} entries, got {actual}")
            }
        }
    }
}

impl std::error::Error for ParserResourceError {}

fn build_local_pool(options: ParserResourceOptions) -> Result<Arc<ThreadPool>, ParserResourceError> {
    if options.rayon_threads == 0 || options.rayon_threads > MAX_PARSER_THREADS {
        return Err(ParserResourceError::InvalidThreadCount {
            requested: options.rayon_threads,
            maximum: MAX_PARSER_THREADS,
        });
    }
    ThreadPoolBuilder::new()
        .num_threads(options.rayon_threads)
        .thread_name(|index| format!("demoparser-{index}"))
        .build()
        .map(Arc::new)
        .map_err(|error| ParserResourceError::ThreadPoolBuild(error.to_string()))
}

fn validate_resource_options(options: ParserResourceOptions) -> Result<(), ParserResourceError> {
    for (resource, requested, maximum) in [
        ("fullpacket segments", options.max_fullpacket_segments, MAX_FULLPACKET_SEGMENTS),
        ("game events", options.max_game_events, MAX_GAME_EVENTS),
        ("decompressed frame bytes", options.max_decompressed_frame_bytes, MAX_DECOMPRESSED_FRAME_BYTES),
        ("aggregate string-table bytes", options.max_string_table_bytes, MAX_STRING_TABLE_BYTES),
        ("voice data bytes", options.max_voice_data_bytes, MAX_VOICE_DATA_BYTES),
        ("inventory data bytes", options.max_inventory_data_bytes, MAX_INVENTORY_DATA_BYTES),
    ] {
        if requested == 0 || requested > maximum {
            return Err(ParserResourceError::InvalidResourceLimit { resource, requested, maximum });
        }
    }
    if options.max_collected_rows > MAX_COLLECTED_ROWS {
        return Err(ParserResourceError::InvalidResourceLimit {
            resource: "collected player rows",
            requested: options.max_collected_rows,
            maximum: MAX_COLLECTED_ROWS,
        });
    }
    Ok(())
}

fn validate_huffman_lookup_table(table: &[(u8, u8)]) -> Result<(), ParserResourceError> {
    if table.len() != HUFFMAN_LOOKUP_TABLE_LEN {
        return Err(ParserResourceError::InvalidHuffmanTableLength {
            expected: HUFFMAN_LOOKUP_TABLE_LEN,
            actual: table.len(),
        });
    }
    Ok(())
}

impl<'a> Parser<'a> {
    pub fn new(input: ParserInputs<'a>, parsing_mode: ParsingMode) -> Self {
        Self::with_resource_options(input, parsing_mode, ParserResourceOptions::default()).expect("default parser resource options are valid")
    }

    pub fn with_resource_options(input: ParserInputs<'a>, parsing_mode: ParsingMode, options: ParserResourceOptions) -> Result<Self, ParserResourceError> {
        validate_resource_options(options)?;
        validate_huffman_lookup_table(input.huffman_lookup_table)?;
        let rayon_pool = build_local_pool(options)?;
        Ok(Parser {
            input,
            parsing_mode,
            rayon_pool,
            resource_options: options,
        })
    }

    pub fn rayon_threads(&self) -> usize {
        self.rayon_pool.current_num_threads()
    }

    pub fn parse_demo(&mut self, demo_bytes: &[u8]) -> Result<DemoOutput, DemoParserError> {
        if demo_bytes.len() < HEADER_ENDS_AT_BYTE {
            return Err(DemoParserError::MalformedMessage);
        }
        if self.parsing_mode == ParsingMode::ForceSingleThreaded {
            return self.parse_demo_inner(demo_bytes);
        }
        let pool = Arc::clone(&self.rayon_pool);
        pool.install(|| self.parse_demo_inner(demo_bytes))
    }

    fn parse_demo_inner(&mut self, demo_bytes: &[u8]) -> Result<DemoOutput, DemoParserError> {
        let mut first_pass_parser = FirstPassParser::with_resource_limits(
            &self.input,
            self.resource_options.max_fullpacket_segments,
            self.resource_options.max_decompressed_frame_bytes,
            self.resource_options.max_string_table_bytes,
        );
        let first_pass_output = first_pass_parser.parse_demo(demo_bytes, false)?;
        if self.parsing_mode == ParsingMode::Normal
            && check_multithreadability(&self.input.wanted_player_props)
            && !(self.parsing_mode == ParsingMode::ForceSingleThreaded)
            || self.parsing_mode == ParsingMode::ForceMultiThreaded
        {
            return self.second_pass_multi_threaded(demo_bytes, first_pass_output);
        } else {
            self.second_pass_single_threaded(demo_bytes, first_pass_output)
        }
    }

    fn second_pass_multi_threaded(&self, outer_bytes: &[u8], first_pass_output: FirstPassOutput) -> Result<DemoOutput, DemoParserError> {
        let event_budget = Arc::new(EventBudget::new(self.resource_options.max_game_events));
        let voice_data_budget = Arc::new(VoiceDataBudget::new(self.resource_options.max_voice_data_bytes));
        let inventory_data_budget = Arc::new(InventoryDataBudget::new(self.resource_options.max_inventory_data_bytes));
        let collected_row_budget = Arc::new(CollectedRowBudget::new(self.resource_options.max_collected_rows));
        let second_pass_outputs: Vec<Result<SecondPassOutput, DemoParserError>> = first_pass_output
            .fullpacket_offsets
            .par_iter()
            .map(|offset| {
                let mut parser = SecondPassParser::with_resource_budget(
                    first_pass_output.clone(),
                    *offset,
                    false,
                    None,
                    Arc::clone(&event_budget),
                    self.resource_options.max_decompressed_frame_bytes,
                    self.resource_options.parse_voice,
                    Arc::clone(&voice_data_budget),
                    Arc::clone(&inventory_data_budget),
                    Arc::clone(&collected_row_budget),
                )?;
                parser.start(outer_bytes)?;
                Ok(parser.create_output())
            })
            .collect();
        // check for errors
        let mut ok = vec![];
        for result in second_pass_outputs {
            match result {
                Err(e) => return Err(e),
                Ok(r) => ok.push(r),
            };
        }
        let mut outputs = self.combine_outputs(&mut ok, first_pass_output)?;
        if let Some(new_df) = self.rm_unwanted_ticks(&mut outputs.df) {
            outputs.df = new_df;
        }
        Parser::remove_duplicate_player_connects(&mut outputs.game_events);
        Parser::add_item_purchase_sell_column(&mut outputs.game_events);
        Parser::remove_item_sold_events(&mut outputs.game_events);
        Ok(outputs)
    }
    fn remove_duplicate_player_connects(events: &mut Vec<GameEvent>) {
        let mut v = events.iter().filter(|x| x.name == "player_first_connect").collect_vec();
        v.sort_by_key(|x| x.tick);
        let mut ids = AHashMap::default();
        for x in v {
            for f in &x.fields {
                if f.name == "steamid" {
                    if let Some(Variant::U64(s)) = f.data {
                        match ids.get(&s) {
                            Some(_) => {}
                            None => {
                                ids.insert(s, x.clone());
                            }
                        }
                    }
                }
            }
        }
        events.retain(|x| x.name != "player_first_connect");
        events.extend(ids.values().map(|x| x.clone()));
    }
    fn second_pass_single_threaded(&self, outer_bytes: &[u8], first_pass_output: FirstPassOutput) -> Result<DemoOutput, DemoParserError> {
        let mut parser = SecondPassParser::with_resource_budget(
            first_pass_output.clone(),
            16,
            true,
            None,
            Arc::new(EventBudget::new(self.resource_options.max_game_events)),
            self.resource_options.max_decompressed_frame_bytes,
            self.resource_options.parse_voice,
            Arc::new(VoiceDataBudget::new(self.resource_options.max_voice_data_bytes)),
            Arc::new(InventoryDataBudget::new(self.resource_options.max_inventory_data_bytes)),
            Arc::new(CollectedRowBudget::new(self.resource_options.max_collected_rows)),
        )?;
        parser.start(outer_bytes)?;
        let second_pass_output = parser.create_output();
        let mut outputs = self.combine_outputs(&mut vec![second_pass_output], first_pass_output)?;
        if let Some(new_df) = self.rm_unwanted_ticks(&mut outputs.df) {
            outputs.df = new_df;
        }
        Parser::add_item_purchase_sell_column(&mut outputs.game_events);
        Parser::remove_item_sold_events(&mut outputs.game_events);
        Ok(outputs)
    }
    fn remove_item_sold_events(events: &mut Vec<GameEvent>) {
        events.retain(|x| x.name != "item_sold")
    }
    fn add_item_purchase_sell_column(events: &mut Vec<GameEvent>) {
        // Checks each item_purchase event for if the item was eventually sold

        let purchase_events = events.iter().filter(|x| x.name == "item_purchase").collect_vec();
        let sells = events.iter().filter(|x| x.name == "item_sold").collect_vec();

        let purchase_helpers = purchase_events.iter().map(|event| SellBackHelper::from_event(event)).collect_vec();
        let purchases = purchase_helpers.iter().filter_map(Option::as_ref).collect_vec();
        let sells = sells.iter().filter_map(|event| SellBackHelper::from_event(event)).collect_vec();

        let mut valid_flags = Self::purchase_was_sold_flags(&purchases, &sells).into_iter();
        let was_sold = purchase_helpers
            .iter()
            .map(|helper| if helper.is_some() { valid_flags.next().unwrap_or(false) } else { false })
            .collect_vec();
        let mut idx = 0;
        for event in events {
            if event.name == "item_purchase" {
                event.fields.push(EventField {
                    name: "was_sold".to_string(),
                    data: Some(Variant::Bool(was_sold.get(idx).copied().unwrap_or(false))),
                });
                idx += 1;
            }
        }
    }

    fn purchase_was_sold_flags(purchases: &[&SellBackHelper], sells: &[SellBackHelper]) -> Vec<bool> {
        use std::collections::BTreeMap;

        let mut buy_ticks: BTreeMap<(u64, u32), Vec<i32>> = BTreeMap::new();
        let mut sell_ticks: BTreeMap<(u64, u32), Vec<i32>> = BTreeMap::new();
        for purchase in purchases {
            buy_ticks.entry((purchase.steamid, purchase.inventory_slot)).or_default().push(purchase.tick);
        }
        for sell in sells {
            sell_ticks.entry((sell.steamid, sell.inventory_slot)).or_default().push(sell.tick);
        }
        for ticks in buy_ticks.values_mut().chain(sell_ticks.values_mut()) {
            ticks.sort_unstable();
        }

        purchases
            .iter()
            .map(|purchase| {
                let key = (purchase.steamid, purchase.inventory_slot);
                let next_buy = buy_ticks
                    .get(&key)
                    .and_then(|ticks| ticks.get(ticks.partition_point(|tick| *tick <= purchase.tick)));
                let next_sell = sell_ticks
                    .get(&key)
                    .and_then(|ticks| ticks.get(ticks.partition_point(|tick| *tick <= purchase.tick)));
                matches!((next_sell, next_buy), (Some(sell), Some(buy)) if sell < buy)
            })
            .collect()
    }
    fn rm_unwanted_ticks(&self, hm: &mut AHashMap<u32, PropColumn>) -> Option<AHashMap<u32, PropColumn>> {
        // Used for removing ticks when velocity is needed
        if self.input.wanted_ticks.is_empty() {
            return None;
        }
        let mut wanted_indicies = vec![];
        if let Some(ticks) = hm.get(&TICK_ID) {
            if let Some(VarVec::I32(t)) = &ticks.data {
                for (idx, val) in t.iter().enumerate() {
                    if let Some(tick) = val {
                        if self.input.wanted_ticks.contains(tick) {
                            wanted_indicies.push(idx);
                        }
                    }
                }
            }
        }
        let mut new_df = AHashMap::default();
        for (k, v) in hm {
            if let Some(new) = v.slice_to_new(&wanted_indicies) {
                new_df.insert(*k, new);
            }
        }
        Some(new_df)
    }

    fn combine_outputs(&self, second_pass_outputs: &mut Vec<SecondPassOutput>, first_pass_output: FirstPassOutput) -> Result<DemoOutput, DemoParserError> {
        // Combines all inner DemoOutputs into one big output
        let mut outputs = std::mem::take(second_pass_outputs);
        outputs.sort_by_key(|x| x.ptr);

        if outputs.len() == 1 {
            let output = outputs.pop().unwrap();
            let mut prop_controller = first_pass_output.prop_controller.clone();
            for prop in first_pass_output.added_temp_props {
                prop_controller.wanted_player_props.retain(|x| x != &prop);
                prop_controller.prop_infos.retain(|x| &x.prop_name != &prop);
            }

            let mut pp = AHashMap::default();
            for (steamid, mut df) in output.df_per_player {
                df.remove(&STEAMID_ID);
                df.remove(&NAME_ID);
                pp.insert(steamid, df);
            }

            let mut all_prop_names: Vec<String> = output.uniq_prop_names.into_iter().collect();
            all_prop_names.sort();
            all_prop_names.dedup();

            let roster = {
                let mut by_sid: std::collections::BTreeMap<u64, PlayerEndMetaData> = std::collections::BTreeMap::new();
                for p in output.roster {
                    if let Some(sid) = p.steamid {
                        if sid != 0 {
                            by_sid.insert(sid, p);
                        }
                    }
                }
                by_sid.into_values().collect()
            };

            if output.game_events.len() > self.resource_options.max_game_events {
                return Err(DemoParserError::ResourceLimitExceeded {
                    resource: "game events",
                    limit: self.resource_options.max_game_events,
                    actual: output.game_events.len(),
                });
            }
            return Ok(DemoOutput {
                prop_controller,
                chat_messages: output.chat_messages,
                item_drops: output.item_drops,
                player_md: output.player_md,
                roster,
                player_userids: first_pass_output.player_userids.as_ref().clone(),
                game_events: output.game_events,
                skins: output.skins,
                convars: output.convars,
                df: output.df,
                header: Some(first_pass_output.header),
                game_events_counter: output.game_events_counter,
                projectiles: output.projectiles,
                voice_data: output.voice_data,
                df_per_player: pp,
                uniq_prop_names: all_prop_names,
            });
        }

        let mut dfs = Vec::with_capacity(outputs.len());
        let mut per_players: AHashMap<u64, Vec<AHashMap<u32, PropColumn>>> = AHashMap::default();
        let mut all_game_events = AHashSet::default();
        let mut all_prop_names = Vec::new();
        let mut chat_messages = Vec::new();
        let mut item_drops = Vec::new();
        let mut player_md = Vec::new();
        let mut roster_by_sid: std::collections::BTreeMap<u64, PlayerEndMetaData> = std::collections::BTreeMap::new();
        let mut game_events = Vec::new();
        let mut skins = Vec::new();
        let mut convars = AHashMap::default();
        let mut projectiles = Vec::new();
        let mut voice_data = Vec::new();

        for output in outputs {
            dfs.push(output.df);
            for event_name in output.game_events_counter {
                all_game_events.insert(event_name);
            }
            all_prop_names.extend(output.uniq_prop_names);
            for (steamid, df) in output.df_per_player {
                per_players.entry(steamid).or_default().push(df);
            }
            chat_messages.extend(output.chat_messages);
            item_drops.extend(output.item_drops);
            player_md.extend(output.player_md);
            for p in output.roster {
                if let Some(sid) = p.steamid {
                    if sid != 0 {
                        roster_by_sid.insert(sid, p);
                    }
                }
            }
            let next_game_event_count = game_events
                .len()
                .checked_add(output.game_events.len())
                .ok_or(DemoParserError::ResourceLimitExceeded {
                    resource: "game events",
                    limit: self.resource_options.max_game_events,
                    actual: usize::MAX,
                })?;
            if next_game_event_count > self.resource_options.max_game_events {
                return Err(DemoParserError::ResourceLimitExceeded {
                    resource: "game events",
                    limit: self.resource_options.max_game_events,
                    actual: next_game_event_count,
                });
            }
            game_events.extend(output.game_events);
            skins.extend(output.skins);
            convars.extend(output.convars);
            projectiles.extend(output.projectiles);
            voice_data.extend(output.voice_data);
        }

        let all_dfs_combined = self.combine_dfs(dfs, false);
        all_prop_names.sort();
        all_prop_names.dedup();
        // Remove temp props
        let mut prop_controller = first_pass_output.prop_controller.clone();
        for prop in first_pass_output.added_temp_props {
            prop_controller.wanted_player_props.retain(|x| x != &prop);
            prop_controller.prop_infos.retain(|x| &x.prop_name != &prop);
        }
        let mut pp = AHashMap::default();
        for (steamid, v) in per_players {
            let combined = self.combine_dfs(v, true);
            pp.insert(steamid, combined);
        }

        Ok(DemoOutput {
            prop_controller: prop_controller,
            chat_messages,
            item_drops,
            player_md,
            // Second-pass segments are sorted by ascending tick. Each captures a player's state
            // at its last tick; dedup by steamid keeping the LAST entry -> final name/team.
            roster: roster_by_sid.into_values().collect(),
            player_userids: first_pass_output.player_userids.as_ref().clone(),
            game_events,
            skins,
            convars,
            df: all_dfs_combined,
            header: Some(first_pass_output.header),
            game_events_counter: all_game_events,
            projectiles,
            voice_data,
            df_per_player: pp,
            uniq_prop_names: all_prop_names,
        })
    }

    fn combine_dfs(&self, mut v: Vec<AHashMap<u32, PropColumn>>, remove_name_and_steamid: bool) -> AHashMap<u32, PropColumn> {
        let mut big: AHashMap<u32, PropColumn> = AHashMap::default();
        if v.len() == 1 {
            let mut result = v.remove(0);
            if remove_name_and_steamid {
                result.remove(&STEAMID_ID);
                result.remove(&NAME_ID);
            }
            return result;
        }

        // Pre-group each chunk's columns into per-prop ordered buckets. This only MOVES the
        // PropColumn structs (no row-data copy) and preserves chunk (offset) order, so the
        // first bucket entry is the seed and the rest are appended in order — identical to the
        // serial insert/extend_from it replaces.
        let mut groups: AHashMap<u32, Vec<PropColumn>> = AHashMap::default();
        for part_df in v {
            for (k, col) in part_df {
                if remove_name_and_steamid && (k == STEAMID_ID || k == NAME_ID) {
                    continue;
                }
                groups.entry(k).or_default().push(col);
            }
        }
        // Concatenate each prop's segments in parallel. Columns are independent and the per-prop
        // order is preserved, so the result is byte-identical to the serial merge. This is the
        // dominant serial cost in the multi-threaded path (~25% of MT wall-clock on large demos).
        let groups_vec: Vec<(u32, Vec<PropColumn>)> = groups.into_iter().collect();
        let combined: Vec<(u32, PropColumn)> = groups_vec
            .into_par_iter()
            .map(|(k, mut segs)| {
                let mut acc = segs.remove(0);
                for mut seg in segs {
                    acc.extend_from(&mut seg);
                }
                (k, acc)
            })
            .collect();
        big.extend(combined);
        big
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;

    #[test]
    fn default_thread_count_is_bounded_by_available_parallelism_and_eight() {
        let expected = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .min(DEFAULT_MAX_PARSER_THREADS);

        assert_eq!(ParserResourceOptions::default().rayon_threads, expected);
        assert!(!ParserResourceOptions::default().parse_voice);
    }

    #[test]
    fn local_pool_accepts_bounded_counts_and_rejects_invalid_counts() {
        for rayon_threads in [1, 2, 4, 8, 16] {
            let pool = build_local_pool(ParserResourceOptions {
                rayon_threads,
                ..ParserResourceOptions::default()
            })
            .expect("bounded local pool");
            assert_eq!(pool.current_num_threads(), rayon_threads);
        }
        for requested in [0, MAX_PARSER_THREADS + 1] {
            let error = build_local_pool(ParserResourceOptions {
                rayon_threads: requested,
                ..ParserResourceOptions::default()
            })
            .expect_err("invalid thread count");
            assert_eq!(
                error,
                ParserResourceError::InvalidThreadCount {
                    requested,
                    maximum: MAX_PARSER_THREADS,
                }
            );
        }
    }

    #[test]
    fn local_pool_install_does_not_resize_the_global_pool() {
        let global_threads = rayon::current_num_threads();
        let pool = ThreadPoolBuilder::new().num_threads(2).build().expect("local pool");

        assert_eq!(pool.install(rayon::current_num_threads), 2);
        assert_eq!(rayon::current_num_threads(), global_threads);
    }

    #[test]
    fn resource_limits_reject_zero_and_values_above_hard_maxima() {
        for options in [
            ParserResourceOptions {
                max_fullpacket_segments: 0,
                ..ParserResourceOptions::default()
            },
            ParserResourceOptions {
                max_game_events: MAX_GAME_EVENTS + 1,
                ..ParserResourceOptions::default()
            },
            ParserResourceOptions {
                max_decompressed_frame_bytes: MAX_DECOMPRESSED_FRAME_BYTES + 1,
                ..ParserResourceOptions::default()
            },
            ParserResourceOptions {
                max_voice_data_bytes: MAX_VOICE_DATA_BYTES + 1,
                ..ParserResourceOptions::default()
            },
            ParserResourceOptions {
                max_inventory_data_bytes: MAX_INVENTORY_DATA_BYTES + 1,
                ..ParserResourceOptions::default()
            },
            ParserResourceOptions {
                max_collected_rows: MAX_COLLECTED_ROWS + 1,
                ..ParserResourceOptions::default()
            },
        ] {
            assert!(matches!(
                validate_resource_options(options),
                Err(ParserResourceError::InvalidResourceLimit { .. })
            ));
        }
    }

    #[test]
    fn huffman_table_must_cover_every_seventeen_bit_prefix() {
        assert!(validate_huffman_lookup_table(&vec![(0, 0); HUFFMAN_LOOKUP_TABLE_LEN]).is_ok());
        assert_eq!(
            validate_huffman_lookup_table(&vec![(0, 0); HUFFMAN_LOOKUP_TABLE_LEN - 1]),
            Err(ParserResourceError::InvalidHuffmanTableLength {
                expected: HUFFMAN_LOOKUP_TABLE_LEN,
                actual: HUFFMAN_LOOKUP_TABLE_LEN - 1,
            })
        );
    }

    #[test]
    fn purchase_sell_index_preserves_next_sell_before_next_buy_semantics() {
        let purchases = vec![
            SellBackHelper {
                tick: 10,
                steamid: 1,
                inventory_slot: 2,
            },
            SellBackHelper {
                tick: 30,
                steamid: 1,
                inventory_slot: 2,
            },
            SellBackHelper {
                tick: 50,
                steamid: 1,
                inventory_slot: 2,
            },
            SellBackHelper {
                tick: 10,
                steamid: 2,
                inventory_slot: 2,
            },
        ];
        let sells = vec![
            SellBackHelper {
                tick: 20,
                steamid: 1,
                inventory_slot: 2,
            },
            SellBackHelper {
                tick: 60,
                steamid: 1,
                inventory_slot: 2,
            },
            SellBackHelper {
                tick: 20,
                steamid: 2,
                inventory_slot: 2,
            },
        ];

        assert_eq!(
            Parser::purchase_was_sold_flags(&purchases.iter().collect_vec(), &sells),
            vec![true, false, false, false]
        );
    }

    #[test]
    fn incomplete_purchase_event_gets_safe_false_sell_flag() {
        let mut events = vec![GameEvent {
            name: "item_purchase".to_owned(),
            fields: vec![],
            tick: 10,
        }];

        Parser::add_item_purchase_sell_column(&mut events);

        assert!(events[0]
            .fields
            .iter()
            .any(|field| { field.name == "was_sold" && field.data == Some(Variant::Bool(false)) }));
    }
}

#[derive(Debug)]
pub struct SellBackHelper {
    pub tick: i32,
    pub steamid: u64,
    pub inventory_slot: u32,
}
impl SellBackHelper {
    pub fn from_event(event: &GameEvent) -> Option<Self> {
        if let Some(Variant::I32(tick)) = SellBackHelper::extract_field("tick", &event.fields) {
            if let Some(Variant::U64(steamid)) = SellBackHelper::extract_field("steamid", &event.fields) {
                if let Some(Variant::U32(slot)) = SellBackHelper::extract_field("inventory_slot", &event.fields) {
                    return Some(SellBackHelper {
                        tick: tick,
                        steamid: steamid,
                        inventory_slot: slot,
                    });
                }
            }
        }
        None
    }
    fn extract_field(name: &str, fields: &[EventField]) -> Option<Variant> {
        for field in fields {
            if field.name == name {
                return field.data.clone();
            }
        }
        None
    }
}
