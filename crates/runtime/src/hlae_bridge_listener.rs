//! PID-bound loopback WebSocket transport for the managed HLAE bridge.

use std::{net::Ipv4Addr, time::Duration};

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
        protocol::WebSocketConfig,
    },
};
use vibe_cs_hlae::{
    HLAE_MIRV_BRIDGE_MAX_ARTIFACT_BYTES, HLAE_MIRV_BRIDGE_MIN_DYNAMIC_PORT, HLAE_MIRV_BRIDGE_PATH,
    HLAE_SESSION_MAX_MESSAGE_BYTES, HlaeBridgeControlMessage, HlaeSessionProtocolError,
};
use vibe_cs_platform_windows::{
    PlatformError, ProcessCancellation, connecting_process_id_for_accepted_loopback_tcp,
};

const MAX_BIND_ATTEMPTS: usize = 8;
const MAXIMUM_ACCEPT_TIMEOUT: Duration = Duration::from_secs(60);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Failures before an authenticated bridge observation reaches the protocol
/// state machine.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeHlaeBridgeError {
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error("managed HLAE bridge {operation} timed out")]
    Timeout { operation: &'static str },
    #[error("managed HLAE bridge handshake failed: {0}")]
    Handshake(String),
    #[error("managed HLAE bridge connection closed before another observation")]
    Closed,
    #[error("managed HLAE bridge sent an unsupported WebSocket message")]
    UnsupportedMessage,
    #[error(transparent)]
    Protocol(#[from] HlaeSessionProtocolError),
}

/// A one-job listener bound only to IPv4 loopback and an OS-selected dynamic
/// port accepted by the generated bridge contract.
#[derive(Debug)]
pub struct RuntimeHlaeBridgeListener {
    listener: TcpListener,
    endpoint: String,
}

impl RuntimeHlaeBridgeListener {
    /// Reserves an ephemeral loopback endpoint before bridge compilation.
    ///
    /// # Errors
    ///
    /// Returns an I/O-backed [`PlatformError`] if no canonical dynamic
    /// loopback endpoint can be reserved within the fixed retry limit.
    pub async fn bind() -> Result<Self, RuntimeHlaeBridgeError> {
        for _ in 0..MAX_BIND_ATTEMPTS {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|error| PlatformError::Io {
                    operation: "binding managed HLAE bridge listener",
                    path: "127.0.0.1:0".into(),
                    source: error,
                })?;
            let address = listener.local_addr().map_err(|error| PlatformError::Io {
                operation: "reading managed HLAE bridge listener address",
                path: "127.0.0.1:0".into(),
                source: error,
            })?;
            if address.is_ipv4()
                && address.ip().is_loopback()
                && address.port() >= HLAE_MIRV_BRIDGE_MIN_DYNAMIC_PORT
            {
                let endpoint = format!("ws://{address}{HLAE_MIRV_BRIDGE_PATH}");
                return Ok(Self { listener, endpoint });
            }
        }
        Err(PlatformError::Windows(format!(
            "the OS did not reserve an HLAE bridge port in {HLAE_MIRV_BRIDGE_MIN_DYNAMIC_PORT}..=65535 after {MAX_BIND_ATTEMPTS} attempts"
        ))
        .into())
    }

    /// Returns the exact endpoint to embed in the generated one-job bridge.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Accepts exactly one socket, proves that its initiator is the managed CS2
    /// PID, then performs a path-restricted, size-bounded WebSocket handshake.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid PID/timeout inputs, cancellation, timeout,
    /// owner mismatch, an unsafe HTTP request target, or a failed handshake.
    pub async fn accept(
        self,
        expected_game_process_id: u32,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> Result<RuntimeHlaeBridgeConnection, RuntimeHlaeBridgeError> {
        if expected_game_process_id == 0 || timeout.is_zero() || timeout > MAXIMUM_ACCEPT_TIMEOUT {
            return Err(PlatformError::InvalidInput(
                "HLAE bridge accept requires a non-zero game PID and a timeout up to 60 seconds"
                    .to_owned(),
            )
            .into());
        }
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None }.into());
        }
        let accepted = tokio::select! {
            result = self.listener.accept() => result.map_err(|error| PlatformError::Io {
                operation: "accepting managed HLAE bridge connection",
                path: self.listener.local_addr().map_or_else(
                    |_| "127.0.0.1".into(),
                    |address| address.to_string().into(),
                ),
                source: error,
            })?,
            () = cancellation.cancelled() => {
                return Err(PlatformError::Cancelled { process_id: None }.into());
            }
            () = tokio::time::sleep(timeout) => {
                return Err(RuntimeHlaeBridgeError::Timeout { operation: "accept" });
            }
        };
        let (stream, peer) = accepted;
        let listener = stream.local_addr().map_err(|error| PlatformError::Io {
            operation: "reading accepted HLAE bridge listener endpoint",
            path: "127.0.0.1".into(),
            source: error,
        })?;
        let owner = connecting_process_id_for_accepted_loopback_tcp(listener, peer)?;
        if owner != expected_game_process_id {
            return Err(PlatformError::InvalidInput(format!(
                "HLAE bridge connection belongs to process {owner}, expected managed CS2 process {expected_game_process_id}"
            ))
            .into());
        }

        #[allow(clippy::result_large_err)]
        let callback = |request: &Request, response: Response| {
            if request.uri().path() == HLAE_MIRV_BRIDGE_PATH && request.uri().query().is_none() {
                Ok(response)
            } else {
                let mut rejection = ErrorResponse::new(Some(
                    "managed HLAE bridge request target is invalid".to_owned(),
                ));
                *rejection.status_mut() = StatusCode::NOT_FOUND;
                Err(rejection)
            }
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(HLAE_SESSION_MAX_MESSAGE_BYTES))
            .max_frame_size(Some(HLAE_SESSION_MAX_MESSAGE_BYTES));
        let websocket = tokio::select! {
            result = accept_hdr_async_with_config(stream, callback, Some(config)) => {
                result.map_err(|error| RuntimeHlaeBridgeError::Handshake(error.to_string()))?
            }
            () = cancellation.cancelled() => {
                return Err(PlatformError::Cancelled {
                    process_id: Some(expected_game_process_id),
                }.into());
            }
            () = tokio::time::sleep(HANDSHAKE_TIMEOUT) => {
                return Err(RuntimeHlaeBridgeError::Timeout { operation: "handshake" });
            }
        };
        Ok(RuntimeHlaeBridgeConnection { websocket })
    }
}

/// One PID-authenticated bridge socket. Server-to-game traffic can only be
/// emitted through the current typed advance/finish control envelope.
#[derive(Debug)]
pub struct RuntimeHlaeBridgeConnection {
    websocket: WebSocketStream<TcpStream>,
}

impl RuntimeHlaeBridgeConnection {
    /// Sends one bounded, authenticated typed control. There is deliberately
    /// no raw text sender on this production boundary.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid timeout, cancellation, protocol
    /// encoding failure, transport closure, or send timeout.
    pub async fn send_control(
        &mut self,
        control: &HlaeBridgeControlMessage,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> Result<(), RuntimeHlaeBridgeError> {
        if timeout.is_zero() || timeout > MAXIMUM_ACCEPT_TIMEOUT {
            return Err(PlatformError::InvalidInput(
                "HLAE bridge control timeout must be at most 60 seconds".to_owned(),
            )
            .into());
        }
        let encoded = control.encode()?;
        let text = String::from_utf8(encoded).map_err(|_| {
            RuntimeHlaeBridgeError::Handshake(
                "typed HLAE bridge control was not valid UTF-8".to_owned(),
            )
        })?;
        tokio::select! {
            result = self.websocket.send(Message::Text(text.into())) => {
                result.map_err(|error| RuntimeHlaeBridgeError::Handshake(error.to_string()))?;
            }
            () = cancellation.cancelled() => {
                return Err(PlatformError::Cancelled { process_id: None }.into());
            }
            () = tokio::time::sleep(timeout) => {
                return Err(RuntimeHlaeBridgeError::Timeout { operation: "control send" });
            }
        }
        Ok(())
    }

    /// Receives one bounded text observation for `HlaeSessionMachine`.
    ///
    /// # Errors
    ///
    /// Returns an error for timeout, cancellation, transport closure, a
    /// non-text WebSocket message, or a message over the protocol limit.
    pub async fn receive(
        &mut self,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> Result<Vec<u8>, RuntimeHlaeBridgeError> {
        if timeout.is_zero() || timeout > MAXIMUM_ACCEPT_TIMEOUT {
            return Err(PlatformError::InvalidInput(
                "HLAE bridge receive timeout must be at most 60 seconds".to_owned(),
            )
            .into());
        }
        let message = tokio::select! {
            result = self.websocket.next() => result,
            () = cancellation.cancelled() => {
                return Err(PlatformError::Cancelled { process_id: None }.into());
            }
            () = tokio::time::sleep(timeout) => {
                return Err(RuntimeHlaeBridgeError::Timeout { operation: "receive" });
            }
        };
        let message = message
            .ok_or(RuntimeHlaeBridgeError::Closed)?
            .map_err(|error| RuntimeHlaeBridgeError::Handshake(error.to_string()))?;
        let Message::Text(text) = message else {
            return Err(RuntimeHlaeBridgeError::UnsupportedMessage);
        };
        if text.len() > HLAE_SESSION_MAX_MESSAGE_BYTES
            || text.len() > HLAE_MIRV_BRIDGE_MAX_ARTIFACT_BYTES
        {
            return Err(PlatformError::InvalidInput(
                "HLAE bridge observation exceeds the protocol limit".to_owned(),
            )
            .into());
        }
        Ok(text.as_bytes().to_vec())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use vibe_cs_hlae::{CaptureTickContract, HlaeBridgeControlMessage, SessionToken};

    use super::*;

    #[tokio::test]
    async fn binds_accepts_and_reads_only_the_exact_current_process_bridge() {
        let listener = RuntimeHlaeBridgeListener::bind().await.unwrap();
        let endpoint = listener.endpoint().to_owned();
        assert!(endpoint.starts_with("ws://127.0.0.1:"));
        assert!(endpoint.ends_with(HLAE_MIRV_BRIDGE_PATH));
        let cancellation = ProcessCancellation::default();
        let accept = listener.accept(std::process::id(), Duration::from_secs(5), &cancellation);
        let connect = connect_async(&endpoint);
        let (accepted, connected) = tokio::join!(accept, connect);
        let mut server = accepted.unwrap();
        let (mut client, _) = connected.unwrap();
        client
            .send(Message::Text("{\"kind\":\"heartbeat\"}".into()))
            .await
            .unwrap();

        assert_eq!(
            server
                .receive(Duration::from_secs(5), &cancellation)
                .await
                .unwrap(),
            br#"{"kind":"heartbeat"}"#
        );
    }

    #[tokio::test]
    async fn rejects_a_websocket_connection_not_owned_by_the_expected_game_pid() {
        let listener = RuntimeHlaeBridgeListener::bind().await.unwrap();
        let endpoint = listener.endpoint().to_owned();
        let cancellation = ProcessCancellation::default();
        let accept = listener.accept(
            std::process::id().saturating_add(1),
            Duration::from_secs(5),
            &cancellation,
        );
        let connect = connect_async(&endpoint);
        let (accepted, connected) = tokio::join!(accept, connect);

        assert!(
            accepted
                .unwrap_err()
                .to_string()
                .contains("belongs to process")
        );
        assert!(connected.is_err());
    }

    #[tokio::test]
    async fn sends_only_a_typed_bounded_control_envelope_to_the_bridge() {
        let listener = RuntimeHlaeBridgeListener::bind().await.unwrap();
        let endpoint = listener.endpoint().to_owned();
        let cancellation = ProcessCancellation::default();
        let accept = listener.accept(std::process::id(), Duration::from_secs(5), &cancellation);
        let connect = connect_async(&endpoint);
        let (accepted, connected) = tokio::join!(accept, connect);
        let mut server = accepted.unwrap();
        let (mut client, _) = connected.unwrap();
        let token = SessionToken::try_from_bytes(&[0x61; 32]).unwrap();
        let ticks = CaptureTickContract::try_new(4_096, 512, 512, 640, 4, 4).unwrap();
        let control = HlaeBridgeControlMessage::advance_take(&token, 1, 1, ticks, None).unwrap();
        let expected = String::from_utf8(control.encode().unwrap()).unwrap();

        server
            .send_control(&control, Duration::from_secs(5), &cancellation)
            .await
            .unwrap();

        let received = client.next().await.unwrap().unwrap();
        assert_eq!(received, Message::Text(expected.into()));
    }
}
