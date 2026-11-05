package streamconfig

// TransportStats describes the sender's SRT socket, not receiver playback or
// end-to-end glass-to-glass delay. Counters cover this connection's lifetime.
type TransportStats struct {
	SendMbps      float64 `json:"send_mbps"`
	RTTMS         float64 `json:"rtt_ms"`
	Retransmitted uint64  `json:"retransmitted_packets"`
	SenderDropped uint64  `json:"sender_dropped_packets"`
	SendBufferMS  uint64  `json:"send_buffer_ms"`
}
