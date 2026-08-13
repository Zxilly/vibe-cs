use std::net::{SocketAddr, SocketAddrV4};

#[cfg(any(windows, test))]
use std::net::Ipv4Addr;

use crate::{PlatformError, PlatformResult};

const DYNAMIC_PORT_START: u16 = 49_152;
#[cfg(any(windows, test))]
const TCP_STATE_ESTABLISHED: u32 = 5;

/// The two IPv4 loopback endpoints observed from an accepted bridge socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AcceptedLoopbackTcpConnection {
    listener: SocketAddrV4,
    peer: SocketAddrV4,
}

impl AcceptedLoopbackTcpConnection {
    /// Validates endpoints reported by `TcpStream::local_addr` and
    /// `TcpStream::peer_addr` on the accepted server-side socket.
    ///
    /// # Errors
    ///
    /// Rejects IPv6, non-loopback addresses, listener ports outside the IANA
    /// dynamic range, and a zero peer port.
    fn new(listener: SocketAddr, peer: SocketAddr) -> PlatformResult<Self> {
        let (SocketAddr::V4(listener), SocketAddr::V4(peer)) = (listener, peer) else {
            return Err(PlatformError::InvalidInput(
                "accepted bridge endpoints must both be IPv4".to_owned(),
            ));
        };
        if !listener.ip().is_loopback() || !peer.ip().is_loopback() {
            return Err(PlatformError::InvalidInput(
                "accepted bridge endpoints must both be IPv4 loopback addresses".to_owned(),
            ));
        }
        if listener.port() < DYNAMIC_PORT_START {
            return Err(PlatformError::InvalidInput(format!(
                "accepted bridge listener port must be in {DYNAMIC_PORT_START}..=65535"
            )));
        }
        if peer.port() == 0 {
            return Err(PlatformError::InvalidInput(
                "accepted bridge peer port must be non-zero".to_owned(),
            ));
        }
        Ok(Self { listener, peer })
    }
}

/// Resolves the process that initiated an already accepted IPv4 loopback TCP
/// connection.
///
/// The lookup deliberately matches the reverse table row (`peer -> listener`),
/// because the forward row belongs to the process that called `accept`. The
/// caller must keep the accepted socket open until this function returns.
///
/// # Errors
///
/// Rejects endpoints outside the managed loopback contract, returns
/// [`PlatformError::Unsupported`] away from Windows, and fails closed unless
/// exactly one established owner row matches the full four-tuple.
pub fn connecting_process_id_for_accepted_loopback_tcp(
    listener: SocketAddr,
    peer: SocketAddr,
) -> PlatformResult<u32> {
    let connection = AcceptedLoopbackTcpConnection::new(listener, peer)?;
    #[cfg(windows)]
    {
        windows_impl::connecting_process_id(connection)
    }
    #[cfg(not(windows))]
    {
        let _ = connection;
        Err(PlatformError::Unsupported)
    }
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TcpOwnerRow {
    state: u32,
    local_address: Ipv4Addr,
    local_port: u16,
    remote_address: Ipv4Addr,
    remote_port: u16,
    owning_process_id: u32,
}

#[cfg(any(windows, test))]
fn connecting_process_id_from_rows(
    connection: AcceptedLoopbackTcpConnection,
    rows: impl IntoIterator<Item = TcpOwnerRow>,
) -> PlatformResult<u32> {
    let listener = connection.listener;
    let peer = connection.peer;
    let mut matches = rows.into_iter().filter(|row| {
        row.state == TCP_STATE_ESTABLISHED
            && row.local_address == *peer.ip()
            && row.local_port == peer.port()
            && row.remote_address == *listener.ip()
            && row.remote_port == listener.port()
    });
    let Some(row) = matches.next() else {
        return Err(PlatformError::ProcessNotFound(
            "connecting loopback TCP endpoint".to_owned(),
        ));
    };
    if matches.next().is_some() {
        return Err(PlatformError::Windows(
            "ambiguous loopback TCP owner: multiple established rows matched the exact connection"
                .to_owned(),
        ));
    }
    if row.owning_process_id == 0 {
        return Err(PlatformError::Windows(
            "exact loopback TCP owner row reported a zero process identifier".to_owned(),
        ));
    }
    Ok(row.owning_process_id)
}

#[cfg(windows)]
mod windows_impl {
    use std::{ffi::c_void, mem::size_of, ptr};

    use windows::Win32::{
        Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
        },
        Networking::WinSock::AF_INET,
    };

    use super::{
        AcceptedLoopbackTcpConnection, Ipv4Addr, PlatformError, PlatformResult, TcpOwnerRow,
        connecting_process_id_from_rows,
    };

    const MAXIMUM_TCP_OWNER_TABLE_BYTES: usize = 16 * 1024 * 1024;
    const MAXIMUM_TCP_OWNER_TABLE_ROWS: usize = 262_144;
    const MAXIMUM_TABLE_SNAPSHOT_ATTEMPTS: usize = 4;

    pub(super) fn connecting_process_id(
        connection: AcceptedLoopbackTcpConnection,
    ) -> PlatformResult<u32> {
        connecting_process_id_from_rows(connection, query_tcp_owner_rows()?)
    }

    fn query_tcp_owner_rows() -> PlatformResult<Vec<TcpOwnerRow>> {
        let mut requested_bytes = 0_u32;
        // SAFETY: a null table is the documented sizing call; `requested_bytes`
        // is writable, AF_INET selects the matching IPv4 row representation,
        // and the reserved argument is required to be zero.
        let sizing_status = unsafe {
            GetExtendedTcpTable(
                None,
                &raw mut requested_bytes,
                false,
                u32::from(AF_INET.0),
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if sizing_status != ERROR_INSUFFICIENT_BUFFER.0 && sizing_status != NO_ERROR.0 {
            return Err(tcp_table_error("sizing", sizing_status));
        }

        for _ in 0..MAXIMUM_TABLE_SNAPSHOT_ATTEMPTS {
            let requested_size = validate_table_size(requested_bytes)?;
            let words = requested_size
                .checked_add(size_of::<u32>() - 1)
                .and_then(|rounded| rounded.checked_div(size_of::<u32>()))
                .ok_or_else(|| {
                    PlatformError::Windows("TCP owner table allocation size overflowed".to_owned())
                })?;
            let allocation_bytes = words.checked_mul(size_of::<u32>()).ok_or_else(|| {
                PlatformError::Windows("TCP owner table allocation size overflowed".to_owned())
            })?;
            let mut storage = Vec::<u32>::new();
            storage.try_reserve_exact(words).map_err(|error| {
                PlatformError::Windows(format!(
                    "could not reserve bounded TCP owner table storage: {error}"
                ))
            })?;
            storage.resize(words, 0);

            let mut returned_bytes = requested_bytes;
            // SAFETY: `storage` is writable for `allocation_bytes` bytes, which
            // is at least the size supplied in `returned_bytes`. The table
            // class and address family agree with the row parser below.
            let status = unsafe {
                GetExtendedTcpTable(
                    Some(storage.as_mut_ptr().cast::<c_void>()),
                    &raw mut returned_bytes,
                    false,
                    u32::from(AF_INET.0),
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                )
            };
            if status == ERROR_INSUFFICIENT_BUFFER.0 {
                requested_bytes = returned_bytes;
                continue;
            }
            if status != NO_ERROR.0 {
                return Err(tcp_table_error("reading", status));
            }
            let returned_size = validate_table_size(returned_bytes)?;
            if returned_size > allocation_bytes {
                return Err(PlatformError::Windows(format!(
                    "TCP owner table returned {returned_size} bytes into a {allocation_bytes}-byte allocation"
                )));
            }
            // SAFETY: the successful API call initialized `returned_size`
            // bytes in aligned storage. The parser validates the untrusted row
            // count and all size arithmetic before reading any row.
            return unsafe { decode_tcp_owner_rows(storage.as_ptr().cast::<u8>(), returned_size) };
        }

        Err(PlatformError::Windows(
            "TCP owner table changed size during every bounded snapshot attempt".to_owned(),
        ))
    }

    fn validate_table_size(bytes: u32) -> PlatformResult<usize> {
        let bytes = usize::try_from(bytes).map_err(|_| {
            PlatformError::Windows("TCP owner table size does not fit usize".to_owned())
        })?;
        if bytes < size_of::<u32>() {
            return Err(PlatformError::Windows(format!(
                "TCP owner table is smaller than its row-count header ({bytes} bytes)"
            )));
        }
        if bytes > MAXIMUM_TCP_OWNER_TABLE_BYTES {
            return Err(PlatformError::Windows(format!(
                "TCP owner table exceeds the {MAXIMUM_TCP_OWNER_TABLE_BYTES}-byte safety limit"
            )));
        }
        Ok(bytes)
    }

    /// Decodes the bounded buffer returned by `GetExtendedTcpTable`.
    ///
    /// # Safety
    ///
    /// `table` must point to at least `table_bytes` initialized bytes that stay
    /// alive for the duration of this call.
    unsafe fn decode_tcp_owner_rows(
        table: *const u8,
        table_bytes: usize,
    ) -> PlatformResult<Vec<TcpOwnerRow>> {
        if table.is_null() || table_bytes < size_of::<u32>() {
            return Err(PlatformError::Windows(
                "TCP owner table buffer is missing its row-count header".to_owned(),
            ));
        }
        // SAFETY: the caller guarantees an initialized four-byte header.
        let row_count = usize::try_from(unsafe { ptr::read_unaligned(table.cast::<u32>()) })
            .map_err(|_| {
                PlatformError::Windows("TCP owner row count does not fit usize".to_owned())
            })?;
        if row_count > MAXIMUM_TCP_OWNER_TABLE_ROWS {
            return Err(PlatformError::Windows(format!(
                "TCP owner table exceeds the {MAXIMUM_TCP_OWNER_TABLE_ROWS}-row safety limit"
            )));
        }
        let row_bytes = row_count
            .checked_mul(size_of::<MIB_TCPROW_OWNER_PID>())
            .ok_or_else(|| {
                PlatformError::Windows("TCP owner row byte count overflowed".to_owned())
            })?;
        let required_bytes = size_of::<u32>().checked_add(row_bytes).ok_or_else(|| {
            PlatformError::Windows("TCP owner table byte count overflowed".to_owned())
        })?;
        if required_bytes > table_bytes {
            return Err(PlatformError::Windows(format!(
                "TCP owner table declares {row_count} rows requiring {required_bytes} bytes, but only {table_bytes} were returned"
            )));
        }

        let mut rows = Vec::new();
        rows.try_reserve_exact(row_count).map_err(|error| {
            PlatformError::Windows(format!(
                "could not reserve bounded TCP owner row storage: {error}"
            ))
        })?;
        // SAFETY: `required_bytes` proves every row-sized read remains inside
        // the caller-provided initialized buffer. `read_unaligned` avoids
        // imposing an alignment requirement on the flexible-array offset.
        let first_row = unsafe { table.add(size_of::<u32>()) };
        for index in 0..row_count {
            let offset = index
                .checked_mul(size_of::<MIB_TCPROW_OWNER_PID>())
                .ok_or_else(|| {
                    PlatformError::Windows("TCP owner row offset overflowed".to_owned())
                })?;
            // SAFETY: the checked table layout above covers this complete row.
            let raw = unsafe {
                ptr::read_unaligned(first_row.add(offset).cast::<MIB_TCPROW_OWNER_PID>())
            };
            rows.push(TcpOwnerRow {
                state: raw.dwState,
                local_address: Ipv4Addr::from(raw.dwLocalAddr.to_ne_bytes()),
                local_port: decode_network_port(raw.dwLocalPort),
                remote_address: Ipv4Addr::from(raw.dwRemoteAddr.to_ne_bytes()),
                remote_port: decode_network_port(raw.dwRemotePort),
                owning_process_id: raw.dwOwningPid,
            });
        }
        Ok(rows)
    }

    fn decode_network_port(raw: u32) -> u16 {
        // Windows documents only the low 16 bits of this DWORD; the upper bits
        // may be uninitialized. Windows targets are little-endian, so the first
        // two native bytes are the network-order port bytes.
        let bytes = raw.to_ne_bytes();
        u16::from_be_bytes([bytes[0], bytes[1]])
    }

    fn tcp_table_error(operation: &str, status: u32) -> PlatformError {
        PlatformError::Windows(format!(
            "GetExtendedTcpTable failed while {operation} the IPv4 owner table (Win32 status {status})"
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_a_reported_table_larger_than_the_allocation_ceiling() {
            let oversized = u32::try_from(MAXIMUM_TCP_OWNER_TABLE_BYTES + 1)
                .expect("configured byte limit fits u32");

            assert!(matches!(
                validate_table_size(oversized),
                Err(PlatformError::Windows(message)) if message.contains("safety limit")
            ));
        }

        #[test]
        fn rejects_a_declared_row_count_above_the_hard_ceiling() {
            let row_count = u32::try_from(MAXIMUM_TCP_OWNER_TABLE_ROWS + 1)
                .expect("configured row limit fits u32");

            // SAFETY: the decoder receives the initialized four-byte header and
            // rejects its row count before attempting to access any row.
            let result = unsafe {
                decode_tcp_owner_rows((&raw const row_count).cast::<u8>(), size_of::<u32>())
            };

            assert!(matches!(
                result,
                Err(PlatformError::Windows(message)) if message.contains("row safety limit")
            ));
        }

        #[test]
        fn rejects_a_table_whose_checked_row_extent_exceeds_returned_bytes() {
            let row_count = 1_u32;

            // SAFETY: the decoder receives the initialized four-byte header and
            // validates the computed row extent before attempting to read it.
            let result = unsafe {
                decode_tcp_owner_rows((&raw const row_count).cast::<u8>(), size_of::<u32>())
            };

            assert!(matches!(
                result,
                Err(PlatformError::Windows(message)) if message.contains("only 4 were returned")
            ));
        }

        #[test]
        fn decodes_only_the_documented_low_sixteen_port_bits() {
            assert_eq!(decode_network_port(0xDEAD_28A0), 41_000);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(ip: [u8; 4], port: u16) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(ip), port))
    }

    #[test]
    fn identifies_the_connecting_side_of_an_accepted_socket() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 2], 41_000),
        )
        .expect("valid accepted connection");
        let client_row = TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::new(127, 0, 0, 2),
            local_port: 41_000,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port: 55_321,
            owning_process_id: 7_654,
        };

        assert_eq!(
            connecting_process_id_from_rows(connection, [client_row])
                .expect("client row must match"),
            7_654
        );
    }

    #[test]
    fn does_not_mistake_the_accepted_server_row_for_the_connecting_process() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 2], 41_000),
        )
        .expect("valid accepted connection");
        let accepted_server_row = TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::LOCALHOST,
            local_port: 55_321,
            remote_address: Ipv4Addr::new(127, 0, 0, 2),
            remote_port: 41_000,
            owning_process_id: 1_234,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [accepted_server_row]),
            Err(PlatformError::ProcessNotFound(_))
        ));
    }

    #[test]
    fn rejects_rows_with_either_wrong_port() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 1], 41_000),
        )
        .expect("valid accepted connection");
        let row = |local_port, remote_port| TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::LOCALHOST,
            local_port,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port,
            owning_process_id: 7_654,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [row(40_999, 55_321), row(41_000, 55_322)]),
            Err(PlatformError::ProcessNotFound(_))
        ));
    }

    #[test]
    fn rejects_an_exact_four_tuple_that_is_not_established() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 1], 41_000),
        )
        .expect("valid accepted connection");
        let row = TcpOwnerRow {
            state: 4,
            local_address: Ipv4Addr::LOCALHOST,
            local_port: 41_000,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port: 55_321,
            owning_process_id: 7_654,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [row]),
            Err(PlatformError::ProcessNotFound(_))
        ));
    }

    #[test]
    fn rejects_non_loopback_endpoints_before_any_owner_lookup() {
        assert!(matches!(
            AcceptedLoopbackTcpConnection::new(
                endpoint([192, 0, 2, 1], 55_321),
                endpoint([127, 0, 0, 1], 41_000)
            ),
            Err(PlatformError::InvalidInput(_))
        ));
        assert!(matches!(
            AcceptedLoopbackTcpConnection::new(
                endpoint([127, 0, 0, 1], 55_321),
                endpoint([192, 0, 2, 2], 41_000)
            ),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn enforces_the_listener_dynamic_range_and_nonzero_peer_port() {
        assert!(matches!(
            AcceptedLoopbackTcpConnection::new(
                endpoint([127, 0, 0, 1], DYNAMIC_PORT_START - 1),
                endpoint([127, 0, 0, 1], 41_000)
            ),
            Err(PlatformError::InvalidInput(_))
        ));
        assert!(matches!(
            AcceptedLoopbackTcpConnection::new(
                endpoint([127, 0, 0, 1], DYNAMIC_PORT_START),
                endpoint([127, 0, 0, 1], 0)
            ),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_ipv6_loopback_endpoints() {
        let ipv6 = SocketAddr::new(std::net::Ipv6Addr::LOCALHOST.into(), 55_321);
        assert!(matches!(
            AcceptedLoopbackTcpConnection::new(ipv6, endpoint([127, 0, 0, 1], 41_000)),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn does_not_match_non_loopback_owner_rows() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 2], 41_000),
        )
        .expect("valid accepted connection");
        let row = TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::new(192, 0, 2, 2),
            local_port: 41_000,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port: 55_321,
            owning_process_id: 7_654,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [row]),
            Err(PlatformError::ProcessNotFound(_))
        ));
    }

    #[test]
    fn rejects_an_ambiguous_exact_connection_match() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 1], 41_000),
        )
        .expect("valid accepted connection");
        let row = |owning_process_id| TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::LOCALHOST,
            local_port: 41_000,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port: 55_321,
            owning_process_id,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [row(7_654), row(8_765)]),
            Err(PlatformError::Windows(message)) if message.contains("ambiguous")
        ));
    }

    #[test]
    fn rejects_a_zero_owner_pid_in_an_otherwise_exact_row() {
        let connection = AcceptedLoopbackTcpConnection::new(
            endpoint([127, 0, 0, 1], 55_321),
            endpoint([127, 0, 0, 1], 41_000),
        )
        .expect("valid accepted connection");
        let row = TcpOwnerRow {
            state: TCP_STATE_ESTABLISHED,
            local_address: Ipv4Addr::LOCALHOST,
            local_port: 41_000,
            remote_address: Ipv4Addr::LOCALHOST,
            remote_port: 55_321,
            owning_process_id: 0,
        };

        assert!(matches!(
            connecting_process_id_from_rows(connection, [row]),
            Err(PlatformError::Windows(message)) if message.contains("zero")
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn live_owner_lookup_is_explicitly_unsupported_away_from_windows() {
        assert!(matches!(
            connecting_process_id_for_accepted_loopback_tcp(
                endpoint([127, 0, 0, 1], 55_321),
                endpoint([127, 0, 0, 1], 41_000)
            ),
            Err(PlatformError::Unsupported)
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "exercises the live Windows TCP owner table"]
    fn live_lookup_identifies_the_process_that_connected_to_the_listener() {
        use std::net::{TcpListener, TcpStream};

        let listener = (DYNAMIC_PORT_START..=u16::MAX)
            .find_map(|port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok())
            .expect("one dynamic loopback listener port must be available");
        let client = TcpStream::connect(listener.local_addr().expect("listener endpoint"))
            .expect("connect loopback client");
        let (accepted, _) = listener.accept().expect("accept loopback client");

        let process_id = connecting_process_id_for_accepted_loopback_tcp(
            accepted.local_addr().expect("accepted local endpoint"),
            accepted.peer_addr().expect("accepted peer endpoint"),
        )
        .expect("resolve connecting process");

        assert_eq!(process_id, std::process::id());
        drop((accepted, client));
    }
}
