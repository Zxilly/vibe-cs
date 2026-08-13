use super::read_bits::{Bitreader, DemoParserError};
use crate::first_pass::parser_settings::FirstPassParser;
use crate::second_pass::parser_settings::SecondPassParser;
use csgoproto::CMsgPlayerInfo;
use csgoproto::CsvcMsgCreateStringTable;
use csgoproto::CsvcMsgUpdateStringTable;
use prost::Message;
use snap::raw::{decompress_len, Decoder};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug)]
pub(crate) struct StringTableBudget {
    limit: usize,
    claimed: AtomicUsize,
}

impl StringTableBudget {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            claimed: AtomicUsize::new(0),
        }
    }

    pub(crate) fn claim(&self, bytes: usize) -> Result<(), DemoParserError> {
        let result = self.claimed.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |claimed| {
            claimed.checked_add(bytes).filter(|total| *total <= self.limit)
        });
        match result {
            Ok(_) => Ok(()),
            Err(claimed) => Err(DemoParserError::ResourceLimitExceeded {
                resource: "aggregate string-table bytes",
                limit: self.limit,
                actual: claimed.saturating_add(bytes),
            }),
        }
    }
}

pub(crate) fn bounded_string_table_bytes(input: &[u8], per_blob_limit: usize, budget: &StringTableBudget) -> Result<Vec<u8>, DemoParserError> {
    if input.len() > per_blob_limit {
        return Err(DemoParserError::ResourceLimitExceeded {
            resource: "decompressed string-table bytes",
            limit: per_blob_limit,
            actual: input.len(),
        });
    }
    budget.claim(input.len())?;
    Ok(input.to_vec())
}

fn bounded_string_table_decompress(input: &[u8], per_blob_limit: usize, budget: &StringTableBudget) -> Result<Vec<u8>, DemoParserError> {
    let needed = decompress_len(input).map_err(|_| DemoParserError::MalformedMessage)?;
    if needed > per_blob_limit {
        return Err(DemoParserError::ResourceLimitExceeded {
            resource: "decompressed string-table bytes",
            limit: per_blob_limit,
            actual: needed,
        });
    }
    budget.claim(needed)?;
    let mut output = vec![0; needed];
    let written = Decoder::new().decompress(input, &mut output).map_err(|_| DemoParserError::MalformedMessage)?;
    output.truncate(written);
    Ok(output)
}

#[derive(Clone, Debug)]
pub struct StringTable {
    name: String,
    user_data_size: i32,
    user_data_fixed: bool,
    #[allow(dead_code)]
    data: Vec<StringTableEntry>,
    flags: i32,
    var_bit_counts: bool,
}
#[derive(Clone, Debug)]
pub struct StringTableEntry {
    pub idx: i32,
    pub key: String,
    pub value: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct UserInfo {
    pub steamid: u64,
    pub name: String,
    pub userid: i32,
    pub is_hltv: bool,
}

impl<'a> FirstPassParser<'a> {
    pub fn update_string_table(&mut self, bytes: &[u8]) -> Result<(), DemoParserError> {
        let table = CsvcMsgUpdateStringTable::decode(bytes).map_err(|_| DemoParserError::MalformedMessage)?;

        let st = self.string_tables.get(table.table_id() as usize).ok_or(DemoParserError::StringTableNotFound)?;
        self.parse_string_table(
            bounded_string_table_bytes(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
            table.num_changed_entries(),
            st.name.clone(),
            st.user_data_fixed,
            st.user_data_size,
            st.flags,
            st.var_bit_counts,
        )?;
        Ok(())
    }

    pub fn parse_create_stringtable(&mut self, bytes: &[u8]) -> Result<(), DemoParserError> {
        let table = CsvcMsgCreateStringTable::decode(bytes).map_err(|_| DemoParserError::MalformedMessage)?;

        if !(table.name() == "instancebaseline" || table.name() == "userinfo") {
            return Ok(());
        }
        let bytes = match table.data_compressed() {
            true => bounded_string_table_decompress(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
            false => bounded_string_table_bytes(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
        };
        self.parse_string_table(
            bytes,
            table.num_entries(),
            table.name().to_string(),
            table.user_data_fixed_size(),
            table.user_data_size(),
            table.flags(),
            table.using_varint_bitcounts(),
        )?;
        Ok(())
    }
    pub fn parse_string_table(
        &mut self,
        bytes: Vec<u8>,
        n_updates: i32,
        name: String,
        udf: bool,
        user_data_size: i32,
        flags: i32,
        variant_bit_count: bool,
    ) -> Result<(), DemoParserError> {
        let mut bitreader = Bitreader::new(&bytes);
        let mut idx = -1;
        let mut keys: Vec<String> = vec![];
        let mut items = vec![];

        for _upd in 0..n_updates {
            let mut key = "".to_owned();
            let mut value = vec![];

            // Increment index
            match bitreader.read_boolean()? {
                true => idx += 1,
                false => idx += (bitreader.read_varint()? + 1) as i32,
            };
            // Does the value have a key
            if bitreader.read_boolean()? {
                // Should we refer back to history (similar to LZ77)
                match bitreader.read_boolean()? {
                    // If no history then just read the data as one string
                    false => key = key.to_owned() + &bitreader.read_string()?,
                    // Refer to history
                    true => {
                        // How far into history we should look
                        let position = bitreader.read_nbits(5)?;
                        // How many bytes in a row, starting from distance ago, should be copied
                        let length = bitreader.read_nbits(5)?;

                        if position >= keys.len() as u32 {
                            key = key.to_owned() + &bitreader.read_string()?;
                        } else {
                            if let Some(s) = &keys.get(position as usize) {
                                if length > s.len() as u32 {
                                    key = key.to_owned() + &s + &bitreader.read_string()?;
                                } else {
                                    key = key.to_owned() + &s.get(0..length as usize).unwrap_or("") + &bitreader.read_string()?;
                                }
                            }
                        }
                    }
                }
                if keys.len() >= 32 {
                    keys.remove(0);
                }
                keys.push(key.clone());
                // Does the entry have a value
                if bitreader.read_boolean()? {
                    let bits: u32;
                    let mut is_compressed = false;

                    match udf {
                        true => bits = user_data_size as u32,
                        false => {
                            if (flags & 0x1) != 0 {
                                is_compressed = bitreader.read_boolean()?;
                            }
                            if variant_bit_count {
                                bits = bitreader.read_u_bit_var()? * 8;
                            } else {
                                bits = bitreader.read_nbits(17)? * 8;
                            }
                        }
                    }
                    value = bitreader.read_n_bytes((bits.checked_div(8).unwrap_or(0)) as usize)?;
                    value = if is_compressed {
                        bounded_string_table_decompress(&value, self.max_decompressed_frame_bytes, &self.string_table_budget)?
                    } else {
                        value
                    };
                }
                if name == "userinfo" {
                    if let Ok(player) = parse_userinfo(&value) {
                        if player.steamid != 0 {
                            observe_player_userid(&mut self.player_userids, &player);
                            self.stringtable_players.insert(player.userid, player);
                        }
                    }
                }
                if name == "instancebaseline" {
                    match key.parse::<u32>() {
                        Ok(cls_id) => {
                            self.string_table_budget.claim(value.len())?;
                            self.baselines.insert(cls_id, value.clone())
                        }
                        Err(_e) => None,
                    };
                }
                items.push(StringTableEntry { idx, key, value });
            }
        }
        self.string_tables.push(StringTable {
            data: items,
            name,
            user_data_size,
            user_data_fixed: udf,
            flags,
            var_bit_counts: variant_bit_count,
        });
        Ok(())
    }
}
pub fn parse_userinfo(bytes: &[u8]) -> Result<UserInfo, DemoParserError> {
    let player = CMsgPlayerInfo::decode(bytes).map_err(|_| DemoParserError::MalformedMessage)?;
    Ok(UserInfo {
        is_hltv: player.ishltv(),
        steamid: player.xuid(),
        name: player.name().to_string(),
        userid: player.userid() & 0xff,
    })
}

pub(crate) fn observe_player_userid(evidence: &mut BTreeMap<u64, Option<i32>>, player: &UserInfo) {
    if player.steamid == 0 {
        return;
    }
    let user_id = player.userid & 0xff;
    evidence
        .entry(player.steamid)
        .and_modify(|known| {
            if *known != Some(user_id) {
                *known = None;
            }
        })
        .or_insert(Some(user_id));
}

impl<'a> SecondPassParser<'a> {
    pub fn update_string_table(&mut self, bytes: &[u8]) -> Result<(), DemoParserError> {
        let table = CsvcMsgUpdateStringTable::decode(bytes).map_err(|_| DemoParserError::MalformedMessage)?;
        match self.string_tables.get(table.table_id() as usize) {
            Some(st) => self.parse_string_table(
                bounded_string_table_bytes(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
                table.num_changed_entries(),
                st.name.clone(),
                st.user_data_fixed,
                st.user_data_size,
                st.flags,
                st.var_bit_counts,
            )?,
            None => {
                return Ok(());
            }
        }
        Ok(())
    }
    pub fn parse_create_stringtable(&mut self, bytes: &[u8]) -> Result<(), DemoParserError> {
        let table = CsvcMsgCreateStringTable::decode(bytes).map_err(|_| DemoParserError::MalformedMessage)?;
        let bytes = match table.data_compressed() {
            true => bounded_string_table_decompress(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
            false => bounded_string_table_bytes(table.string_data(), self.max_decompressed_frame_bytes, &self.string_table_budget)?,
        };
        self.parse_string_table(
            bytes,
            table.num_entries(),
            table.name().to_string(),
            table.user_data_fixed_size(),
            table.user_data_size(),
            table.flags(),
            table.using_varint_bitcounts(),
        )?;
        Ok(())
    }
    pub fn parse_string_table(
        &mut self,
        bytes: Vec<u8>,
        n_updates: i32,
        name: String,
        udf: bool,
        user_data_size: i32,
        flags: i32,
        variant_bit_count: bool,
    ) -> Result<(), DemoParserError> {
        let mut bitreader = Bitreader::new(&bytes);
        let mut idx = -1;
        let mut keys: Vec<String> = vec![];
        let mut items = vec![];

        for _upd in 0..n_updates {
            let mut key = "".to_owned();
            let mut value = vec![];

            // Increment index
            match bitreader.read_boolean()? {
                true => idx += 1,
                false => idx += (bitreader.read_varint()? + 1) as i32,
            };
            // Does the value have a key
            if bitreader.read_boolean()? {
                // Should we refer back to history (similar to LZ77)
                match bitreader.read_boolean()? {
                    // If no history then just read the data as one string
                    false => key = key.to_owned() + &bitreader.read_string()?,
                    // Refer to history
                    true => {
                        // How far into history we should look
                        let position = bitreader.read_nbits(5)?;
                        // How many bytes in a row, starting from distance ago, should be copied
                        let length = bitreader.read_nbits(5)?;

                        if position >= keys.len() as u32 {
                            key = key.to_owned() + &bitreader.read_string()?;
                        } else {
                            let s = &keys[position as usize];
                            if length > s.len() as u32 {
                                key = key.to_owned() + &s + &bitreader.read_string()?;
                            } else {
                                key = key.to_owned() + &s.get(0..length as usize).unwrap_or("") + &bitreader.read_string()?;
                            }
                        }
                    }
                }
                if keys.len() >= 32 {
                    keys.remove(0);
                }
                keys.push(key.clone());
                // Does the entry have a value
                if bitreader.read_boolean()? {
                    let bits: u32;
                    let mut is_compressed = false;

                    match udf {
                        true => bits = user_data_size as u32,
                        false => {
                            if (flags & 0x1) != 0 {
                                is_compressed = bitreader.read_boolean()?;
                            }
                            if variant_bit_count {
                                bits = bitreader.read_u_bit_var()? * 8;
                            } else {
                                bits = bitreader.read_nbits(17)? * 8;
                            }
                        }
                    }
                    value = bitreader.read_n_bytes((bits.checked_div(8).unwrap_or(0)) as usize)?;
                    value = if is_compressed {
                        bounded_string_table_decompress(&value, self.max_decompressed_frame_bytes, &self.string_table_budget)?
                    } else {
                        value
                    };
                }
                if name == "userinfo" {
                    if let Ok(player) = parse_userinfo(&value) {
                        if player.steamid != 0 {
                            Arc::make_mut(&mut self.stringtable_players).insert(player.userid, player);
                        }
                    }
                }
                if name == "instancebaseline" {
                    match key.parse::<u32>() {
                        Ok(cls_id) => {
                            self.string_table_budget.claim(value.len())?;
                            self.baselines.insert(cls_id, value.clone())
                        }
                        Err(_e) => None,
                    };
                }
                items.push(StringTableEntry { idx, key, value });
            }
        }
        Arc::make_mut(&mut self.string_tables).push(StringTable {
            data: items,
            name,
            user_data_size,
            user_data_fixed: udf,
            flags,
            var_bit_counts: variant_bit_count,
        });
        Ok(())
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;

    #[test]
    fn player_userid_evidence_preserves_low_byte_and_rejects_conflicts() {
        let mut evidence = BTreeMap::new();
        let encoded = CMsgPlayerInfo {
            xuid: Some(76_561_198_000_000_001),
            name: Some("one".to_owned()),
            userid: Some(0x12_0007),
            ..CMsgPlayerInfo::default()
        }
        .encode_to_vec();
        let player = parse_userinfo(&encoded).expect("valid CMsgPlayerInfo");

        observe_player_userid(&mut evidence, &player);
        assert_eq!(evidence[&76_561_198_000_000_001], Some(7));

        observe_player_userid(
            &mut evidence,
            &UserInfo {
                steamid: 76_561_198_000_000_001,
                name: "one".to_owned(),
                userid: 8,
                is_hltv: false,
            },
        );
        assert_eq!(evidence[&76_561_198_000_000_001], None);
    }

    #[test]
    fn oversized_snappy_claim_is_rejected_before_output_allocation() {
        let budget = StringTableBudget::new(1_024);
        let error = bounded_string_table_decompress(&[0x81, 0x01], 64, &budget).expect_err("129-byte declared output exceeds limit");

        assert_eq!(
            error,
            DemoParserError::ResourceLimitExceeded {
                resource: "decompressed string-table bytes",
                limit: 64,
                actual: 129,
            }
        );
    }

    #[test]
    fn aggregate_budget_applies_across_individually_valid_blobs() {
        let budget = StringTableBudget::new(3);
        assert!(bounded_string_table_bytes(&[1, 2], 2, &budget).is_ok());
        assert!(matches!(
            bounded_string_table_bytes(&[3, 4], 2, &budget),
            Err(DemoParserError::ResourceLimitExceeded {
                resource: "aggregate string-table bytes",
                limit: 3,
                actual: 4,
            })
        ));
    }

    #[test]
    fn retained_fullpacket_clone_claims_budget_before_allocation() {
        let budget = StringTableBudget::new(3);
        let error = bounded_string_table_bytes(&[1, 2, 3, 4], 8, &budget).expect_err("fullpacket baseline must share the aggregate budget");

        assert_eq!(
            error,
            DemoParserError::ResourceLimitExceeded {
                resource: "aggregate string-table bytes",
                limit: 3,
                actual: 4,
            }
        );
    }
}
