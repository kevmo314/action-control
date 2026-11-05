package main

import (
	"action-control/internal/streamconfig"
	"strings"
	"testing"
	"time"
)

func TestStreamScreenDoesNotReportStaleOrExitedSenderAsLive(t *testing.T) {
	now := time.Now()
	c := streamconfig.DefaultConfig()
	st := livestreamStatus{State: "sending", StartedAt: now.Add(-time.Minute), UpdatedAt: now.Add(-time.Second)}
	severity, lines := streamScreenLines(st, c, true, now)
	if severity != 2 || !strings.Contains(lines[0], "LIVE") {
		t.Fatal(lines)
	}
	st.UpdatedAt = now.Add(-6 * time.Second)
	severity, lines = streamScreenLines(st, c, true, now)
	if severity != 3 || strings.Contains(lines[0], "LIVE") {
		t.Fatal(lines)
	}
	severity, lines = streamScreenLines(st, c, false, now)
	if severity != 0 || !strings.Contains(lines[0], "STOPPED") {
		t.Fatal(lines)
	}
}

func TestStreamScreenReportsMeasuredTransportAndMicWithoutSecrets(t *testing.T) {
	now := time.Now()
	c := streamconfig.DefaultConfig()
	c.Address = "secret.example:9000"
	c.StreamID = "private-key"
	c.Passphrase = "private-passphrase"
	c.Stabilization = "horizonsteady"
	c.NoiseReduction = "dji"
	st := livestreamStatus{State: "sending", AudioSource: "regular0", StartedAt: now.Add(-time.Minute), UpdatedAt: now, Transport: &streamconfig.TransportStats{SendMbps: 2.34, RTTMS: 45, Retransmitted: 12, SenderDropped: 3}}
	_, lines := streamScreenLines(st, c, true, now)
	all := strings.Join(lines[:], "\n")
	for _, want := range []string{"2.34 Mbps", "RTT 45 ms", "RE 12", "DROP 3", "HorizonSteady", "Internal mic", "DJI neural"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q in %s", want, all)
		}
	}
	for _, secret := range []string{c.Address, c.StreamID, c.Passphrase} {
		if strings.Contains(all, secret) {
			t.Fatal("secret on screen")
		}
	}
	st.Transport = nil
	_, lines = streamScreenLines(st, c, true, now)
	if !strings.Contains(lines[2], "--") {
		t.Fatal("missing statistics look like measured zero")
	}
	st.Transport = &streamconfig.TransportStats{SendBufferMS: uint64(c.LatencyMS + 1)}
	severity, lines := streamScreenLines(st, c, true, now)
	if severity != 1 || !strings.Contains(lines[6], "queue") {
		t.Fatal(lines)
	}
}

func TestStreamScreenWireIsBoundedAndSingleLine(t *testing.T) {
	s := screenText("a\nb\r\x00" + strings.Repeat("x", 100))
	if len(s) > 48 || strings.ContainsAny(s, "\r\n\x00") {
		t.Fatal(s)
	}
}
