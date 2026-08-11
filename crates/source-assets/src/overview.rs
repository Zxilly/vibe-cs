use crate::{Result, SourceAssetError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverviewTextLimits {
    pub max_bytes: usize,
    pub max_tokens: usize,
    pub max_token_length: usize,
    pub max_depth: usize,
}

impl Default for OverviewTextLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024,
            max_tokens: 4_096,
            max_token_length: 2_048,
            max_depth: 16,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RadarTransform {
    pub pos_x: f64,
    pub pos_y: f64,
    pub scale: f64,
    pub rotate: Option<bool>,
    pub zoom: Option<f64>,
}

pub fn parse_overview_text(bytes: &[u8]) -> Result<RadarTransform> {
    parse_overview_text_with_limits(bytes, OverviewTextLimits::default())
}

pub fn parse_overview_text_with_limits(
    bytes: &[u8],
    limits: OverviewTextLimits,
) -> Result<RadarTransform> {
    if bytes.len() > limits.max_bytes {
        return Err(SourceAssetError::LimitExceeded {
            kind: "radar overview text",
            actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            limit: u64::try_from(limits.max_bytes).unwrap_or(u64::MAX),
        });
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut lexer = Lexer::new(bytes, limits);
    let mut tokens = Vec::new();
    while let Some(token) = lexer.next_token()? {
        tokens.push(token);
    }
    let mut parser = Parser::new(&tokens, limits.max_depth);
    let root = parser.parse_root()?;
    let object = find_transform_object(&root)?;
    transform_from_object(object)
}

#[derive(Debug)]
enum Token {
    Scalar(String),
    Open,
    Close,
}

struct Lexer<'a> {
    bytes: &'a [u8],
    offset: usize,
    token_count: usize,
    limits: OverviewTextLimits,
}

impl<'a> Lexer<'a> {
    const fn new(bytes: &'a [u8], limits: OverviewTextLimits) -> Self {
        Self {
            bytes,
            offset: 0,
            token_count: 0,
            limits,
        }
    }

    fn next_token(&mut self) -> Result<Option<Token>> {
        self.skip_layout()?;
        let Some(byte) = self.bytes.get(self.offset).copied() else {
            return Ok(None);
        };
        let token = match byte {
            b'{' => {
                self.offset += 1;
                Token::Open
            }
            b'}' => {
                self.offset += 1;
                Token::Close
            }
            b'"' => Token::Scalar(self.read_quoted()?),
            _ => Token::Scalar(self.read_unquoted()?),
        };
        self.token_count = self
            .token_count
            .checked_add(1)
            .ok_or(SourceAssetError::ArithmeticOverflow("overview token count"))?;
        if self.token_count > self.limits.max_tokens {
            return Err(SourceAssetError::LimitExceeded {
                kind: "radar overview token count",
                actual: u64::try_from(self.token_count).unwrap_or(u64::MAX),
                limit: u64::try_from(self.limits.max_tokens).unwrap_or(u64::MAX),
            });
        }
        Ok(Some(token))
    }

    fn skip_layout(&mut self) -> Result<()> {
        loop {
            while let Some(byte) = self.bytes.get(self.offset).copied() {
                if is_layout(byte) {
                    self.offset += 1;
                } else if byte.is_ascii_control() {
                    return Err(self.error("unsupported control character"));
                } else {
                    break;
                }
            }
            if self.bytes.get(self.offset..self.offset.saturating_add(2)) == Some(b"//") {
                self.offset += 2;
                while let Some(byte) = self.bytes.get(self.offset).copied() {
                    if byte == b'\n' || byte == b'\r' {
                        break;
                    }
                    if byte.is_ascii_control() {
                        return Err(self.error("unsupported control character in comment"));
                    }
                    self.offset += 1;
                }
                continue;
            }
            return Ok(());
        }
    }

    fn read_quoted(&mut self) -> Result<String> {
        self.offset += 1;
        let mut value = Vec::new();
        loop {
            let Some(byte) = self.bytes.get(self.offset).copied() else {
                return Err(self.error("unterminated quoted string"));
            };
            self.offset += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let escaped = self
                        .bytes
                        .get(self.offset)
                        .copied()
                        .ok_or_else(|| self.error("unterminated string escape"))?;
                    self.offset += 1;
                    match escaped {
                        b'"' | b'\\' => value.push(escaped),
                        _ => return Err(self.error("unsupported string escape")),
                    }
                }
                byte if byte.is_ascii_control() => {
                    return Err(self.error("control character inside quoted string"));
                }
                byte => value.push(byte),
            }
            self.enforce_token_length(value.len())?;
        }
        String::from_utf8(value).map_err(|_| self.error("quoted string is not valid UTF-8"))
    }

    fn read_unquoted(&mut self) -> Result<String> {
        let start = self.offset;
        while let Some(byte) = self.bytes.get(self.offset).copied() {
            if is_layout(byte) || matches!(byte, b'{' | b'}') {
                break;
            }
            if byte == b'"' {
                return Err(self.error("quote inside unquoted token"));
            }
            if byte.is_ascii_control() {
                return Err(self.error("control character inside unquoted token"));
            }
            self.offset += 1;
            self.enforce_token_length(self.offset - start)?;
        }
        if self.offset == start {
            return Err(self.error("empty token"));
        }
        std::str::from_utf8(&self.bytes[start..self.offset])
            .map(str::to_owned)
            .map_err(|_| self.error("unquoted token is not valid UTF-8"))
    }

    fn enforce_token_length(&self, length: usize) -> Result<()> {
        if length > self.limits.max_token_length {
            return Err(SourceAssetError::LimitExceeded {
                kind: "radar overview token",
                actual: u64::try_from(length).unwrap_or(u64::MAX),
                limit: u64::try_from(self.limits.max_token_length).unwrap_or(u64::MAX),
            });
        }
        Ok(())
    }

    fn error(&self, message: impl Into<String>) -> SourceAssetError {
        SourceAssetError::InvalidOverviewText {
            offset: self.offset,
            message: message.into(),
        }
    }
}

const fn is_layout(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

#[derive(Debug)]
enum Value {
    Scalar(String),
    Object(Object),
}

type Object = Vec<(String, Value)>;

struct Parser<'a> {
    tokens: &'a [Token],
    offset: usize,
    max_depth: usize,
}

impl<'a> Parser<'a> {
    const fn new(tokens: &'a [Token], max_depth: usize) -> Self {
        Self {
            tokens,
            offset: 0,
            max_depth,
        }
    }

    fn parse_root(&mut self) -> Result<Object> {
        self.parse_object(0, false)
    }

    fn parse_object(&mut self, depth: usize, expects_close: bool) -> Result<Object> {
        if depth > self.max_depth {
            return Err(self.error("KeyValues nesting exceeds the configured limit"));
        }
        let mut object = Vec::new();
        loop {
            match self.tokens.get(self.offset) {
                None if expects_close => return Err(self.error("unterminated object")),
                None => return Ok(object),
                Some(Token::Close) if expects_close => {
                    self.offset += 1;
                    return Ok(object);
                }
                Some(Token::Close) => return Err(self.error("unexpected closing brace")),
                Some(Token::Open) => return Err(self.error("object is missing a key")),
                Some(Token::Scalar(key)) => {
                    if key.is_empty() {
                        return Err(self.error("KeyValues key cannot be empty"));
                    }
                    let key = key.clone();
                    self.offset += 1;
                    let value = match self.tokens.get(self.offset) {
                        Some(Token::Scalar(value)) => {
                            self.offset += 1;
                            Value::Scalar(value.clone())
                        }
                        Some(Token::Open) => {
                            self.offset += 1;
                            Value::Object(self.parse_object(depth + 1, true)?)
                        }
                        Some(Token::Close) | None => {
                            return Err(self.error("KeyValues key is missing a value"));
                        }
                    };
                    object.push((key, value));
                }
            }
        }
    }

    fn error(&self, message: impl Into<String>) -> SourceAssetError {
        SourceAssetError::InvalidOverviewText {
            offset: self.offset,
            message: message.into(),
        }
    }
}

fn find_transform_object(root: &Object) -> Result<&Object> {
    let mut candidates = Vec::new();
    collect_transform_objects(root, &mut candidates);
    match candidates.as_slice() {
        [] => Err(SourceAssetError::MissingOverviewField("pos_x")),
        [object] => Ok(object),
        _ => Err(SourceAssetError::InvalidOverviewText {
            offset: 0,
            message: "multiple objects define radar transform fields".to_owned(),
        }),
    }
}

fn collect_transform_objects<'a>(object: &'a Object, candidates: &mut Vec<&'a Object>) {
    if object.iter().any(|(key, _)| is_required_key(key)) {
        candidates.push(object);
        return;
    }
    for (_, value) in object {
        if let Value::Object(child) = value {
            collect_transform_objects(child, candidates);
        }
    }
}

fn is_required_key(key: &str) -> bool {
    ["pos_x", "pos_y", "scale"]
        .iter()
        .any(|candidate| key.eq_ignore_ascii_case(candidate))
}

fn transform_from_object(object: &Object) -> Result<RadarTransform> {
    let pos_x = required_number(object, "pos_x", false)?;
    let pos_y = required_number(object, "pos_y", false)?;
    let scale = required_number(object, "scale", true)?;
    let rotate = optional_scalar(object, "rotate")?
        .map(|value| parse_rotate(&value))
        .transpose()?;
    let zoom = optional_scalar(object, "zoom")?
        .map(|value| parse_number("zoom", &value, true))
        .transpose()?;
    Ok(RadarTransform {
        pos_x,
        pos_y,
        scale,
        rotate,
        zoom,
    })
}

fn required_number(object: &Object, field: &'static str, positive: bool) -> Result<f64> {
    let value =
        optional_scalar(object, field)?.ok_or(SourceAssetError::MissingOverviewField(field))?;
    parse_number(field, &value, positive)
}

fn optional_scalar(object: &Object, field: &'static str) -> Result<Option<String>> {
    let mut found = None;
    for (key, value) in object {
        if !key.eq_ignore_ascii_case(field) {
            continue;
        }
        if found.is_some() {
            return Err(SourceAssetError::InvalidOverviewText {
                offset: 0,
                message: format!("duplicate {field} field"),
            });
        }
        let Value::Scalar(value) = value else {
            return Err(SourceAssetError::InvalidOverviewField {
                field,
                value: "{object}".to_owned(),
            });
        };
        found = Some(value.clone());
    }
    Ok(found)
}

fn parse_number(field: &'static str, value: &str, positive: bool) -> Result<f64> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| SourceAssetError::InvalidOverviewField {
            field,
            value: value.to_owned(),
        })?;
    if !parsed.is_finite() || (positive && parsed <= 0.0) {
        return Err(SourceAssetError::InvalidOverviewField {
            field,
            value: value.to_owned(),
        });
    }
    Ok(parsed)
}

fn parse_rotate(value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "0" | "false" => Ok(false),
        "1" | "true" => Ok(true),
        _ => Err(SourceAssetError::InvalidOverviewField {
            field: "rotate",
            value: value.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_valve_keyvalues_transform() {
        let transform = parse_overview_text(
            br#"
                // standard overview metadata
                "de_safe"
                {
                    "pos_x" "-2476"
                    "pos_y" "3239.5"
                    "scale" "4.4"
                    "rotate" "1"
                    "zoom" "1.25"
                    "unknown" { "nested" "accepted" }
                }
            "#,
        )
        .expect("parse overview");
        assert_eq!(
            transform,
            RadarTransform {
                pos_x: -2476.0,
                pos_y: 3239.5,
                scale: 4.4,
                rotate: Some(true),
                zoom: Some(1.25),
            }
        );
    }

    #[test]
    fn rejects_malformed_non_finite_duplicate_and_control_data() {
        for input in [
            br#""map" { "pos_x" "0" "pos_y" "0" }"#.as_slice(),
            br#""map" { "pos_x" "0" "pos_y" "0" "scale" "0" }"#.as_slice(),
            br#""map" { "pos_x" "NaN" "pos_y" "0" "scale" "1" }"#.as_slice(),
            br#""map" { "pos_x" "0" "pos_y" "0" "scale" "1" "scale" "2" }"#.as_slice(),
            b"\"map\" { \"pos_x\" \"0\" \"pos_y\" \"0\" \"scale\" \"1\" \"x\" \"bad\x01\" }",
            br#""map" { "pos_x" "0" "pos_y" "0" "scale" "1" "#,
        ] {
            assert!(parse_overview_text(input).is_err(), "accepted {input:?}");
        }
    }

    #[test]
    fn enforces_text_token_and_depth_limits() {
        let input = br#""map" { "pos_x" "0" "pos_y" "0" "scale" "1" }"#;
        assert!(matches!(
            parse_overview_text_with_limits(
                input,
                OverviewTextLimits {
                    max_bytes: input.len() - 1,
                    ..OverviewTextLimits::default()
                }
            ),
            Err(SourceAssetError::LimitExceeded {
                kind: "radar overview text",
                ..
            })
        ));
        assert!(matches!(
            parse_overview_text_with_limits(
                input,
                OverviewTextLimits {
                    max_token_length: 2,
                    ..OverviewTextLimits::default()
                }
            ),
            Err(SourceAssetError::LimitExceeded {
                kind: "radar overview token",
                ..
            })
        ));
        assert!(
            parse_overview_text_with_limits(
                br#""map" { "nested" { "pos_x" "0" "pos_y" "0" "scale" "1" } }"#,
                OverviewTextLimits {
                    max_depth: 1,
                    ..OverviewTextLimits::default()
                }
            )
            .is_err()
        );
    }
}
