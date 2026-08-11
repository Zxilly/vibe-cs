use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{IntegrationError, IntegrationResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GsiPayload {
    pub provider: Option<GsiProvider>,
    pub map: Option<GsiMap>,
    pub player: Option<GsiPlayer>,
    pub round: Option<GsiRound>,
    pub bomb: Option<GsiBomb>,
    #[serde(default)]
    pub previously: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiProvider {
    pub name: Option<String>,
    pub appid: Option<u32>,
    pub version: Option<u32>,
    pub steamid: Option<String>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiMap {
    pub mode: Option<String>,
    pub name: Option<String>,
    pub phase: Option<String>,
    pub round: Option<u32>,
    pub team_ct: Option<GsiTeam>,
    pub team_t: Option<GsiTeam>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiTeam {
    pub score: Option<u32>,
    pub name: Option<String>,
    pub consecutive_round_losses: Option<u32>,
    pub timeouts_remaining: Option<u32>,
    pub matches_won_this_series: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GsiPlayer {
    pub steamid: Option<String>,
    pub name: Option<String>,
    pub team: Option<String>,
    pub activity: Option<String>,
    pub state: Option<GsiPlayerState>,
    pub match_stats: Option<GsiMatchStats>,
    pub weapons: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiPlayerState {
    pub health: Option<u32>,
    pub armor: Option<u32>,
    pub helmet: Option<bool>,
    pub flashed: Option<u32>,
    pub smoked: Option<u32>,
    pub burning: Option<u32>,
    pub money: Option<u32>,
    pub round_kills: Option<u32>,
    pub round_killhs: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiMatchStats {
    pub kills: Option<u32>,
    pub assists: Option<u32>,
    pub deaths: Option<u32>,
    pub mvps: Option<u32>,
    pub score: Option<i32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiRound {
    pub phase: Option<String>,
    pub win_team: Option<String>,
    pub bomb: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GsiBomb {
    pub state: Option<String>,
    pub player: Option<String>,
    pub countdown: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GsiState {
    pub latest: Option<GsiPayload>,
    pub received_at: Option<DateTime<Utc>>,
    pub sequence: u64,
}

impl GsiState {
    pub fn apply(&mut self, payload: GsiPayload, received_at: DateTime<Utc>) {
        self.latest = Some(payload);
        self.received_at = Some(received_at);
        self.sequence = self.sequence.saturating_add(1);
    }

    #[must_use]
    pub fn is_fresh(&self, now: DateTime<Utc>, maximum_age: chrono::Duration) -> bool {
        self.received_at.is_some_and(|received| {
            now.signed_duration_since(received) >= chrono::Duration::zero()
                && now.signed_duration_since(received) <= maximum_age
        })
    }
}

/// Parses a bounded CS2 Game State Integration payload.
///
/// # Errors
///
/// Returns an error when the payload exceeds the limit, is malformed, or
/// explicitly identifies an application other than CS2.
pub fn parse_gsi_payload(bytes: &[u8], maximum_bytes: usize) -> IntegrationResult<GsiPayload> {
    if bytes.len() > maximum_bytes {
        return Err(IntegrationError::ResponseLimit(maximum_bytes));
    }
    let payload: GsiPayload = serde_json::from_slice(bytes)?;
    if payload
        .provider
        .as_ref()
        .and_then(|provider| provider.appid)
        .is_some_and(|appid| appid != 730)
    {
        return Err(IntegrationError::InvalidInput(
            "GSI payload is not from app 730".to_owned(),
        ));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_another_game() {
        let error = parse_gsi_payload(br#"{"provider":{"appid":570}}"#, 1024).unwrap_err();
        assert!(matches!(error, IntegrationError::InvalidInput(_)));
    }
}
