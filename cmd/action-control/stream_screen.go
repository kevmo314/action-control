package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"

	"action-control/internal/streamconfig"
)

// A bounded line protocol keeps JSON parsing and formatting out of the native
// GUI process. No destinations, stream IDs, passphrases or overlay URLs appear.
func streamScreenLines(st livestreamStatus, c streamconfig.Config, running bool, now time.Time) (int, [7]string) {
	state, severity := "STANDBY", 0
	elapsed := time.Duration(0)
	if !st.StartedAt.IsZero() {
		end := now
		if !running && !st.UpdatedAt.IsZero() {
			end = st.UpdatedAt
		}
		elapsed = max(time.Duration(0), end.Sub(st.StartedAt))
	}
	switch st.State {
	case "preparing", "connecting":
		state, severity = "CONNECTING", 1
	case "starting":
		state, severity = "STARTING CAMERA", 1
	case "sending":
		state, severity = "LIVE", 2
	case "stopping", "restoring":
		state, severity = "STOPPING", 1
	case "error":
		state, severity = "ERROR", 3
	case "stopped":
		if !st.StartedAt.IsZero() {
			state = "STOPPED"
		}
	}
	if running && (st.State == "sending" || st.State == "starting") && now.Sub(st.UpdatedAt) > 5*time.Second {
		state, severity = "TELEMETRY STALE", 3
	}
	if !running && severity != 3 && state != "STANDBY" {
		state, severity = "STOPPED", 0
	}
	sec := int(elapsed.Seconds())
	lines := [7]string{
		fmt.Sprintf("SRT %s   %02d:%02d:%02d", state, sec/3600, sec/60%60, sec%60),
		fmt.Sprintf("SEND -- Mbps   SET %.1f Mbps", float64(c.BitrateKbps)/1000),
		"RTT -- ms   RESEND --   DROP --",
		fmt.Sprintf("%dx%d / %d fps   HEVC", c.Width, c.Height, c.FPS),
		"EIS " + map[string]string{"": "Off", "off": "Off", "rocksteady": "RockSteady", "horizonsteady": "HorizonSteady", "horizonbalancing": "HorizonBalancing"}[c.Stabilization],
		"AUDIO OFF",
		"Set up and start in the web UI",
	}
	if st.Transport != nil && !st.StartedAt.IsZero() {
		t := st.Transport
		lines[1] = fmt.Sprintf("SEND %.2f Mbps   SET %.1f Mbps", t.SendMbps, float64(c.BitrateKbps)/1000)
		lines[2] = fmt.Sprintf("RTT %.0f ms  RE %d  DROP %d", t.RTTMS, t.Retransmitted, t.SenderDropped)
		if running && severity == 2 && t.SendBufferMS > uint64(max(1, c.LatencyMS)) {
			severity = 1
			lines[6] = "Send queue exceeds SRT latency"
		}
	}
	if st.AudioSource != "" && st.AudioSource != "none" {
		mic := "Selected mic"
		if st.AudioSource == "regular0" {
			mic = "Internal mic"
		} else if strings.Contains(st.AudioSource, "wireless") {
			mic = "DJI wireless"
		}
		nr := map[string]string{"off": "Off", "dji": "DJI neural", "rnnoise": "RNNoise"}[c.NoiseMode()]
		lines[5] = "MIC " + mic + " / NR " + nr
	}
	if running && severity == 2 {
		lines[6] = fmt.Sprintf("SRT %d ms   Sent %.1f MB", c.LatencyMS, float64(st.Bytes)/1e6)
	}
	// Keep arbitrary native errors out of the small display (and avoid leaking a
	// destination). The web UI retains the detailed error for diagnosis.
	if st.State == "error" {
		lines[6] = "Stream failed - check the web UI"
	}
	return severity, lines
}

func screenText(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r > 126 || unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	if len(s) > 48 {
		s = s[:48]
	}
	return s
}

func batteryScreenInfo() string {
	b, err := os.ReadFile("/sys/class/power_supply/battery/capacity")
	if err != nil {
		return ""
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n < 0 || n > 100 {
		return ""
	}
	result := fmt.Sprintf("BAT %d%%", n)
	if b, err = os.ReadFile("/sys/class/power_supply/battery/temp"); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n > 0 && n < 1000 {
			result += fmt.Sprintf(" / %.0f C", float64(n)/10)
		}
	}
	return result
}

func registerStreamScreen(mux *http.ServeMux, s *livestreamController) {
	mux.HandleFunc("GET /api/livestream/rear-screen", func(w http.ResponseWriter, r *http.Request) {
		// Read the same controller/status snapshot as the web UI; never infer LIVE
		// from a leftover status file after its process has exited.
		s.mu.Lock()
		st, c, running := s.last, s.config, s.run != nil
		if running {
			st = s.run.state
			if st.State != "restoring" && st.State != "stopping" {
				if live, ok := readStreamScreenStatus(s.run.statusFile); ok {
					st = live
				}
			}
		}
		s.mu.Unlock()
		severity, lines := streamScreenLines(st, c, running, time.Now())
		if battery := batteryScreenInfo(); battery != "" {
			lines[4] += "   " + battery
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, "AC-SRT/1\n%d\n", severity)
		for _, line := range lines {
			fmt.Fprintln(w, screenText(line))
		}
	})
}

func readStreamScreenStatus(path string) (livestreamStatus, bool) {
	var st livestreamStatus
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &st) != nil {
		return st, false
	}
	return st, true
}
