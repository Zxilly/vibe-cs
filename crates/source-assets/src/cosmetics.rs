use std::collections::{BTreeMap, BTreeSet};

use crate::{
    Cs2AssetStore, DecodedVtexImage, Result, SourceAssetError, VtexDecodeLimits,
    decode_vtex_to_browser_image_with_limits,
};

const ITEMS_GAME_PATH: &str = "scripts/items/items_game.txt";
const ENGLISH_LOCALIZATION_PATH: &str = "resource/csgo_english.txt";
const CHINESE_LOCALIZATION_PATH: &str = "resource/csgo_schinese.txt";
const MAXIMUM_ITEMS_GAME_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_LOCALIZATION_BYTES: usize = 12 * 1024 * 1024;
const MAXIMUM_CATALOG_ITEMS: usize = 4_096;
const MAXIMUM_CATALOG_PAINTS: usize = 64_000;
const MAXIMUM_CATALOG_TOKENS: usize = 1_500_000;
const MAXIMUM_CATALOG_DEPTH: usize = 64;
const MAXIMUM_COSMETIC_IMAGE_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct CosmeticCatalog {
    pub items: Vec<CosmeticCatalogItem>,
    pub paint_kits: Vec<CosmeticPaintKit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmeticCatalogItem {
    pub item_definition_index: u16,
    pub internal_name: String,
    pub display_name: String,
    pub category: CosmeticCatalogCategory,
    pub base_image_path: Option<String>,
    pub paint_kit_ids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CosmeticCatalogCategory {
    Weapon,
    Knife,
    Gloves,
    Agent,
    Equipment,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CosmeticPaintKit {
    pub id: u32,
    pub internal_name: String,
    pub display_name: String,
    pub wear_min: f32,
    pub wear_max: f32,
    pub image_paths: BTreeMap<u16, String>,
}

impl CosmeticCatalog {
    #[must_use]
    pub fn item(&self, item_definition_index: u16) -> Option<&CosmeticCatalogItem> {
        self.items
            .binary_search_by_key(&item_definition_index, |item| item.item_definition_index)
            .ok()
            .and_then(|index| self.items.get(index))
    }

    #[must_use]
    pub fn paint_kit(&self, id: u32) -> Option<&CosmeticPaintKit> {
        self.paint_kits
            .binary_search_by_key(&id, |paint| paint.id)
            .ok()
            .and_then(|index| self.paint_kits.get(index))
    }

    #[must_use]
    pub fn image_path(&self, item_definition_index: u16, paint_kit: u32) -> Option<&str> {
        if paint_kit == 0 {
            return self
                .item(item_definition_index)
                .and_then(|item| item.base_image_path.as_deref());
        }
        self.paint_kit(paint_kit)
            .and_then(|paint| paint.image_paths.get(&item_definition_index))
            .map(String::as_str)
    }
}

impl Cs2AssetStore {
    /// Builds a bounded catalog from the locally installed game's public item schema.
    pub fn cosmetic_catalog(&self) -> Result<CosmeticCatalog> {
        self.cosmetic_catalog_for_locale("en-US")
    }

    /// Builds a bounded catalog using the closest installed localization.
    pub fn cosmetic_catalog_for_locale(&self, locale: &str) -> Result<CosmeticCatalog> {
        let package = self
            .package()
            .ok_or_else(|| SourceAssetError::EntryNotFound(ITEMS_GAME_PATH.to_owned()))?;
        let items_bytes = package.read(ITEMS_GAME_PATH)?;
        enforce_catalog_size(
            "cosmetic item schema",
            items_bytes.len(),
            MAXIMUM_ITEMS_GAME_BYTES,
        )?;
        let preferred_localization = if locale.to_ascii_lowercase().starts_with("zh") {
            CHINESE_LOCALIZATION_PATH
        } else {
            ENGLISH_LOCALIZATION_PATH
        };
        let localization_bytes = package.read(preferred_localization).or_else(|error| {
            if preferred_localization == ENGLISH_LOCALIZATION_PATH {
                Err(error)
            } else {
                package.read(ENGLISH_LOCALIZATION_PATH)
            }
        })?;
        enforce_catalog_size(
            "cosmetic localization",
            localization_bytes.len(),
            MAXIMUM_LOCALIZATION_BYTES,
        )?;
        let items_text = decode_catalog_text(&items_bytes)?;
        let localization_text = decode_catalog_text(&localization_bytes)?;
        let schema = parse_key_values(&items_text)?;
        let localization = parse_key_values(&localization_text)?;
        build_catalog(package, &schema, &localization)
    }

    /// Decodes one allow-listed inventory texture selected from a generated catalog.
    pub fn cosmetic_image(&self, virtual_path: &str) -> Result<DecodedVtexImage> {
        validate_cosmetic_image_path(virtual_path)?;
        let package = self
            .package()
            .ok_or_else(|| SourceAssetError::EntryNotFound(virtual_path.to_owned()))?;
        let entry = package
            .entry(virtual_path)?
            .ok_or_else(|| SourceAssetError::EntryNotFound(virtual_path.to_owned()))?;
        enforce_catalog_size(
            "cosmetic inventory image",
            usize::try_from(entry.total_size()).unwrap_or(usize::MAX),
            MAXIMUM_COSMETIC_IMAGE_BYTES,
        )?;
        let bytes = package.read(virtual_path)?;
        decode_vtex_to_browser_image_with_limits(
            &bytes,
            VtexDecodeLimits {
                max_resource_size: MAXIMUM_COSMETIC_IMAGE_BYTES,
                max_dimension: 4_096,
                max_pixels: 4_096 * 4_096,
                max_decoded_bytes: 64 * 1024 * 1024,
                max_encoded_bytes: 32 * 1024 * 1024,
                ..VtexDecodeLimits::default()
            },
        )
    }
}

fn validate_cosmetic_image_path(path: &str) -> Result<()> {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let allowed_prefix = normalized.starts_with("panorama/images/econ/");
    let allowed_suffix = normalized.ends_with("_png.vtex_c");
    let safe = !normalized.starts_with('/')
        && !normalized.contains("../")
        && !normalized.contains("//")
        && normalized.len() <= 1_024
        && normalized.is_ascii();
    if allowed_prefix && allowed_suffix && safe && normalized == path {
        Ok(())
    } else {
        Err(SourceAssetError::InvalidCosmeticImagePath(path.to_owned()))
    }
}

fn enforce_catalog_size(kind: &'static str, actual: usize, limit: usize) -> Result<()> {
    if actual > limit {
        return Err(SourceAssetError::LimitExceeded {
            kind,
            actual: u64::try_from(actual).unwrap_or(u64::MAX),
            limit: u64::try_from(limit).unwrap_or(u64::MAX),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum KvValue {
    Text(String),
    Object(BTreeMap<String, KvValue>),
}

impl KvValue {
    fn object(&self) -> Option<&BTreeMap<String, Self>> {
        match self {
            Self::Object(value) => Some(value),
            Self::Text(_) => None,
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            Self::Object(_) => None,
        }
    }

    fn child(&self, key: &str) -> Option<&Self> {
        self.object()?.get(key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Text(String),
    Open,
    Close,
}

fn decode_catalog_text(bytes: &[u8]) -> Result<String> {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let content = &bytes[2..];
        if !content.len().is_multiple_of(2) {
            return Err(catalog_error(0, "UTF-16LE input has an odd byte count"));
        }
        let words = content
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words)
            .map_err(|_| catalog_error(0, "UTF-16LE input contains invalid surrogate pairs"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec())
        .map_err(|_| catalog_error(0, "catalog input is not valid UTF-8 or UTF-16LE"))
}

fn parse_key_values(input: &str) -> Result<KvValue> {
    let tokens = tokenize(input)?;
    let mut cursor = 0;
    let object = parse_object(&tokens, &mut cursor, false, 0)?;
    if cursor != tokens.len() {
        return Err(catalog_error(cursor, "unexpected trailing token"));
    }
    Ok(KvValue::Object(object))
}

fn tokenize(input: &str) -> Result<Vec<Token>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
            continue;
        }
        if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'/') {
            cursor += 2;
            while cursor < bytes.len() && bytes[cursor] != b'\n' {
                cursor += 1;
            }
            continue;
        }
        match bytes[cursor] {
            b'{' => {
                tokens.push(Token::Open);
                cursor += 1;
            }
            b'}' => {
                tokens.push(Token::Close);
                cursor += 1;
            }
            b'"' => {
                let start = cursor;
                cursor += 1;
                let mut value = String::new();
                while cursor < bytes.len() {
                    match bytes[cursor] {
                        b'"' => {
                            cursor += 1;
                            break;
                        }
                        b'\\' => {
                            cursor += 1;
                            let escaped = *bytes
                                .get(cursor)
                                .ok_or_else(|| catalog_error(start, "unterminated escape"))?;
                            value.push(match escaped {
                                b'n' => '\n',
                                b't' => '\t',
                                b'r' => '\r',
                                b'"' => '"',
                                b'\\' => '\\',
                                other => char::from(other),
                            });
                            cursor += 1;
                        }
                        byte if byte.is_ascii() => {
                            value.push(char::from(byte));
                            cursor += 1;
                        }
                        _ => {
                            let remaining = &input[cursor..];
                            let character = remaining
                                .chars()
                                .next()
                                .ok_or_else(|| catalog_error(cursor, "invalid UTF-8 boundary"))?;
                            value.push(character);
                            cursor += character.len_utf8();
                        }
                    }
                }
                if cursor > bytes.len() || bytes.get(cursor.saturating_sub(1)) != Some(&b'"') {
                    return Err(catalog_error(start, "unterminated quoted string"));
                }
                tokens.push(Token::Text(value));
            }
            _ => {
                let start = cursor;
                while cursor < bytes.len()
                    && !bytes[cursor].is_ascii_whitespace()
                    && !matches!(bytes[cursor], b'{' | b'}')
                {
                    cursor += 1;
                }
                let value = input
                    .get(start..cursor)
                    .ok_or_else(|| catalog_error(start, "invalid token boundary"))?;
                tokens.push(Token::Text(value.to_owned()));
            }
        }
        if tokens.len() > MAXIMUM_CATALOG_TOKENS {
            return Err(catalog_error(cursor, "catalog token limit exceeded"));
        }
    }
    Ok(tokens)
}

fn parse_object(
    tokens: &[Token],
    cursor: &mut usize,
    expect_close: bool,
    depth: usize,
) -> Result<BTreeMap<String, KvValue>> {
    let mut values = BTreeMap::new();
    loop {
        match tokens.get(*cursor) {
            Some(Token::Close) if expect_close => {
                *cursor += 1;
                return Ok(values);
            }
            None if !expect_close => return Ok(values),
            None => return Err(catalog_error(*cursor, "missing closing brace")),
            Some(Token::Text(_)) => {}
            Some(_) => return Err(catalog_error(*cursor, "expected a key")),
        }
        let Token::Text(key) = &tokens[*cursor] else {
            unreachable!();
        };
        *cursor += 1;
        let value = match tokens.get(*cursor) {
            Some(Token::Text(value)) => {
                *cursor += 1;
                KvValue::Text(value.clone())
            }
            Some(Token::Open) => {
                *cursor += 1;
                if depth >= MAXIMUM_CATALOG_DEPTH {
                    return Err(catalog_error(
                        *cursor,
                        "catalog object nesting limit exceeded",
                    ));
                }
                KvValue::Object(parse_object(tokens, cursor, true, depth + 1)?)
            }
            _ => return Err(catalog_error(*cursor, "expected a value or object")),
        };
        match (values.get_mut(key), value) {
            (Some(KvValue::Object(existing)), KvValue::Object(additional)) => {
                merge_objects(existing, additional);
            }
            (_, value) => {
                values.insert(key.clone(), value);
            }
        }
    }
}

fn merge_objects(target: &mut BTreeMap<String, KvValue>, source: BTreeMap<String, KvValue>) {
    for (key, value) in source {
        match (target.get_mut(&key), value) {
            (Some(KvValue::Object(existing)), KvValue::Object(additional)) => {
                merge_objects(existing, additional);
            }
            (_, value) => {
                target.insert(key, value);
            }
        }
    }
}

fn build_catalog(
    package: &crate::VpkArchive,
    schema: &KvValue,
    localization: &KvValue,
) -> Result<CosmeticCatalog> {
    let root = schema.child("items_game").unwrap_or(schema);
    let items = root
        .child("items")
        .and_then(KvValue::object)
        .ok_or_else(|| catalog_error(0, "items_game.items is missing"))?;
    let prefabs = root
        .child("prefabs")
        .and_then(KvValue::object)
        .ok_or_else(|| catalog_error(0, "items_game.prefabs is missing"))?;
    let localized_tokens = localization_tokens(localization);
    let mut catalog_items = Vec::new();
    let mut names = Vec::<(String, u16)>::new();
    for (raw_id, item) in items {
        let Ok(id) = raw_id.parse::<u16>() else {
            continue;
        };
        if id == 0 || item.object().is_none() {
            continue;
        }
        let Some(name) = resolve_field(item, prefabs, "name", 0) else {
            continue;
        };
        if name.is_empty() || name == "default" {
            continue;
        }
        let category = category_for(&name, item, prefabs);
        let display_token = resolve_field(item, prefabs, "item_name", 0);
        let display_name = localize(display_token.as_deref(), &localized_tokens)
            .unwrap_or_else(|| humanize(&name));
        let image_inventory = resolve_field(item, prefabs, "image_inventory", 0);
        let base_image_path = image_inventory
            .map(|path| format!("panorama/images/{path}_png.vtex_c"))
            .filter(|path| package.entry(path).ok().flatten().is_some());
        catalog_items.push(CosmeticCatalogItem {
            item_definition_index: id,
            internal_name: name.clone(),
            display_name,
            category,
            base_image_path,
            paint_kit_ids: Vec::new(),
        });
        names.push((name, id));
        enforce_catalog_size(
            "cosmetic item count",
            catalog_items.len(),
            MAXIMUM_CATALOG_ITEMS,
        )?;
    }
    catalog_items.sort_by_key(|item| item.item_definition_index);
    names.sort_by_key(|entry| std::cmp::Reverse(entry.0.len()));

    let paint_nodes = root
        .child("paint_kits")
        .and_then(KvValue::object)
        .ok_or_else(|| catalog_error(0, "items_game.paint_kits is missing"))?;
    let mut paint_kits = BTreeMap::<u32, CosmeticPaintKit>::new();
    let mut paint_names = BTreeMap::<String, u32>::new();
    for (raw_id, paint) in paint_nodes {
        let Ok(id) = raw_id.parse::<u32>() else {
            continue;
        };
        let Some(internal_name) = paint.child("name").and_then(KvValue::text) else {
            continue;
        };
        let display_name = localize(
            paint.child("description_tag").and_then(KvValue::text),
            &localized_tokens,
        )
        .or_else(|| {
            localize(
                paint.child("description_string").and_then(KvValue::text),
                &localized_tokens,
            )
        })
        .unwrap_or_else(|| humanize(internal_name));
        let wear_min = parsed_float(paint, "wear_remap_min", 0.0);
        let wear_max = parsed_float(paint, "wear_remap_max", 1.0);
        paint_names.insert(internal_name.to_owned(), id);
        paint_kits.insert(
            id,
            CosmeticPaintKit {
                id,
                internal_name: internal_name.to_owned(),
                display_name,
                wear_min,
                wear_max,
                image_paths: BTreeMap::new(),
            },
        );
        enforce_catalog_size(
            "cosmetic paint count",
            paint_kits.len(),
            MAXIMUM_CATALOG_PAINTS,
        )?;
    }

    let prefix = "panorama/images/econ/default_generated/";
    let suffix = "_light_png.vtex_c";
    for entry in package.entries() {
        let path = entry.path();
        let Some(file) = path
            .strip_prefix(prefix)
            .and_then(|path| path.strip_suffix(suffix))
        else {
            continue;
        };
        let Some((item_name, item_id)) = names.iter().find(|(name, _)| {
            file.starts_with(name) && file.as_bytes().get(name.len()) == Some(&b'_')
        }) else {
            continue;
        };
        let paint_name = &file[item_name.len() + 1..];
        let Some(paint_id) = paint_names.get(paint_name).copied() else {
            continue;
        };
        if let Some(paint) = paint_kits.get_mut(&paint_id) {
            paint.image_paths.insert(*item_id, path.to_owned());
        }
    }

    let mut item_paints = BTreeMap::<u16, BTreeSet<u32>>::new();
    for paint in paint_kits.values() {
        for item_id in paint.image_paths.keys() {
            item_paints.entry(*item_id).or_default().insert(paint.id);
        }
    }
    for item in &mut catalog_items {
        item.paint_kit_ids = item_paints
            .remove(&item.item_definition_index)
            .unwrap_or_default()
            .into_iter()
            .collect();
    }
    Ok(CosmeticCatalog {
        items: catalog_items,
        paint_kits: paint_kits.into_values().collect(),
    })
}

fn localization_tokens(root: &KvValue) -> BTreeMap<String, String> {
    let tokens = root
        .child("lang")
        .and_then(|lang| lang.child("Tokens").or_else(|| lang.child("tokens")))
        .and_then(KvValue::object);
    tokens.map_or_else(BTreeMap::new, |tokens| {
        tokens
            .iter()
            .filter_map(|(key, value)| {
                value.text().map(|value| {
                    (
                        key.trim_start_matches('#').to_ascii_lowercase(),
                        value.to_owned(),
                    )
                })
            })
            .collect()
    })
}

fn localize(token: Option<&str>, localization: &BTreeMap<String, String>) -> Option<String> {
    let token = token?.trim_start_matches('#').to_ascii_lowercase();
    localization.get(&token).cloned()
}

fn resolve_field(
    value: &KvValue,
    prefabs: &BTreeMap<String, KvValue>,
    field: &str,
    depth: usize,
) -> Option<String> {
    if depth > 16 {
        return None;
    }
    if let Some(value) = value.child(field).and_then(KvValue::text) {
        return Some(value.to_owned());
    }
    let prefab_names = value.child("prefab").and_then(KvValue::text)?;
    prefab_names.split_ascii_whitespace().find_map(|name| {
        prefabs
            .get(name)
            .and_then(|prefab| resolve_field(prefab, prefabs, field, depth + 1))
    })
}

fn category_for(
    name: &str,
    item: &KvValue,
    prefabs: &BTreeMap<String, KvValue>,
) -> CosmeticCatalogCategory {
    let class = resolve_field(item, prefabs, "item_class", 0).unwrap_or_default();
    let combined = format!("{name} {class}").to_ascii_lowercase();
    if combined.contains("customplayer") || combined.contains("agent") {
        CosmeticCatalogCategory::Agent
    } else if combined.contains("glove") || combined.contains("hands") {
        CosmeticCatalogCategory::Gloves
    } else if combined.contains("knife") || combined.contains("bayonet") {
        CosmeticCatalogCategory::Knife
    } else if combined.contains("weapon") {
        CosmeticCatalogCategory::Weapon
    } else {
        CosmeticCatalogCategory::Equipment
    }
}

fn parsed_float(value: &KvValue, key: &str, fallback: f32) -> f32 {
    value
        .child(key)
        .and_then(KvValue::text)
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(0.0, 1.0)
}

fn humanize(value: &str) -> String {
    value
        .trim_start_matches("weapon_")
        .replace('_', " ")
        .split_whitespace()
        .map(|part| {
            let mut characters = part.chars();
            characters.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(characters).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn catalog_error(offset: usize, message: impl Into<String>) -> SourceAssetError {
    SourceAssetError::InvalidCosmeticCatalog {
        offset,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    #[test]
    fn parser_handles_comments_escapes_and_utf16() {
        let parsed =
            parse_key_values("// comment\n\"root\" { \"name\" \"A\\\"B\" }").expect("parse");
        assert_eq!(
            parsed
                .child("root")
                .and_then(|root| root.child("name"))
                .and_then(KvValue::text),
            Some("A\"B")
        );
        let utf16 = "\u{feff}\"lang\" { \"Tokens\" { \"A\" \"B\" } }"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_catalog_text(&utf16).expect("decode UTF-16");
        assert!(decoded.contains("Tokens"));
    }

    #[test]
    fn cosmetic_paths_are_strictly_namespaced() {
        assert!(
            validate_cosmetic_image_path(
                "panorama/images/econ/default_generated/weapon_ak47_test_light_png.vtex_c"
            )
            .is_ok()
        );
        assert!(validate_cosmetic_image_path("../secret.vtex_c").is_err());
        assert!(
            validate_cosmetic_image_path("panorama/images/econ/../../secret_png.vtex_c").is_err()
        );
    }

    #[test]
    fn parser_merges_repeated_object_sections() {
        let parsed = parse_key_values(
            "\"root\" { \"items\" { \"1\" \"first\" } \"items\" { \"2\" \"second\" } }",
        )
        .expect("parse repeated sections");
        let items = parsed
            .child("root")
            .and_then(|root| root.child("items"))
            .and_then(KvValue::object)
            .expect("merged items");
        assert_eq!(items.len(), 2);
        assert_eq!(items.get("1").and_then(KvValue::text), Some("first"));
        assert_eq!(items.get("2").and_then(KvValue::text), Some("second"));
    }

    #[test]
    fn parser_rejects_maliciously_deep_objects() {
        let mut input = String::new();
        for index in 0..=MAXIMUM_CATALOG_DEPTH {
            write!(input, "\"level-{index}\" {{ ").expect("write fixture");
        }
        input.push_str("\"value\" \"leaf\" ");
        for _ in 0..=MAXIMUM_CATALOG_DEPTH {
            input.push_str("} ");
        }

        let error = parse_key_values(&input).expect_err("deep nesting must be rejected");
        assert!(error.to_string().contains("nesting limit"));
    }
}
