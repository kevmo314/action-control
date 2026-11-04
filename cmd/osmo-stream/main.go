// osmo-stream owns capture, HEVC hardware encoding, and SRT transport.
// It calls native capture libraries directly, without gst-launch or FFmpeg.
package main

import (
	"action-control/internal/hwstream"
	"action-control/internal/streamconfig"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	srt "github.com/datarhei/gosrt"
)

type status struct {
	AudioProcessing hwstream.ProcessorStats `json:"audio_processing"`
	State           string                  `json:"state"`
	Codec           string                  `json:"codec"`
	Bytes           uint64                  `json:"bytes"`
	StartedAt       time.Time               `json:"started_at"`
	UpdatedAt       time.Time               `json:"updated_at"`
	Error           string                  `json:"error,omitempty"`
	AudioSource     string                  `json:"audio_source"`
	AudioCodec      string                  `json:"audio_codec"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() (err error) {
	configPath := flag.String("config", "", "private JSON configuration path")
	statusPath := flag.String("status-file", "", "atomic JSON status output")
	output := flag.String("output", "", "write diagnostic MPEG-TS file instead of SRT")
	test := flag.Bool("test-pattern", false, "test the hardware encoder without opening the sensor")
	duration := flag.Duration("duration", 0, "optional run duration")
	flag.Parse()
	c := hwstream.DefaultConfig()
	if *configPath != "" {
		b, e := os.ReadFile(*configPath)
		if e != nil {
			return e
		}
		if e = json.Unmarshal(b, &c); e != nil {
			return e
		}
	}
	if *output != "" && c.Address == "" {
		c.Address = "127.0.0.1:9000"
	}
	if e := c.Validate(); e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *duration > 0 {
		var stop context.CancelFunc
		ctx, stop = context.WithTimeout(ctx, *duration)
		defer stop()
	}
	st := status{State: "connecting", Codec: "H.265 / HEVC", StartedAt: time.Now().UTC()}
	st.AudioSource = c.AudioSource
	if c.AudioSource != "none" && c.AudioSource != "" {
		st.AudioCodec = "AAC-LC 48 kHz stereo"
		if c.NeuralAudio() {
			st.AudioCodec = "AAC-LC 48 kHz mono"
		}
	}
	writeStatus := func() {
		st.UpdatedAt = time.Now().UTC()
		if *statusPath != "" {
			b, _ := json.Marshal(st)
			if e := os.WriteFile(*statusPath+".tmp", b, 0600); e == nil {
				_ = os.Rename(*statusPath+".tmp", *statusPath)
			}
		}
	}
	writeStatus()
	defer func() {
		st.State = "stopped"
		if err != nil {
			st.State = "error"
			st.Error = err.Error()
		}
		writeStatus()
	}()
	var initialAudio *streamconfig.AudioSource
	if c.AudioSource != "none" && c.AudioSource != "" {
		query, stop := context.WithTimeout(ctx, 3*time.Second)
		sources, e := streamconfig.AudioSources(query)
		stop()
		if e != nil {
			return e
		}
		c.AudioSource, e = streamconfig.ResolveAudioSource(c.AudioSource, sources)
		if e != nil {
			return e
		}
		for _, source := range sources {
			if source.Name == c.AudioSource {
				v := source
				initialAudio = &v
			}
		}
		if c.AudioSource == "regular0" && (initialAudio == nil || initialAudio.ActivePort != "handset-mic" || initialAudio.SampleSpec != "s24-32le 4ch 48000Hz") {
			return errors.New("unsupported internal microphone format or route")
		}
	}
	if e := c.Validate(); e != nil {
		return e
	}
	st.AudioSource = c.AudioSource
	var dest io.WriteCloser
	if *output != "" {
		dest, err = os.OpenFile(*output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	} else {
		cfg := srt.DefaultConfig()
		cfg.StreamId = c.StreamID
		cfg.Passphrase = c.Passphrase
		cfg.Latency = time.Duration(c.LatencyMS) * time.Millisecond
		cfg.ConnectionTimeout = 5 * time.Second
		dest, err = srt.DialWithContext(ctx, "srt", c.Address, cfg)
	}
	if err != nil {
		return errors.New("could not connect to SRT receiver or open diagnostic output")
	}
	if *output == "" {
		dest = newBufferedOutput(dest, time.Duration(c.LatencyMS)*time.Millisecond)
	}
	defer func() {
		_ = dest.Close()
		if b, ok := dest.(*bufferedOutput); ok {
			st.Bytes = b.sent.Load()
		}
	}()
	// Allow a bounded encoder/mux/transport drain on stop. Closing the output
	// after the grace period still unblocks a stalled network Write.
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-finished:
			return
		case <-ctx.Done():
		}
		select {
		case <-finished:
			return
		case <-time.After(3 * time.Second):
			_ = dest.Close()
		}
	}()
	st.State = "starting"
	writeStatus()
	capture, e := hwstream.Open(c, *test)
	if e != nil {
		return e
	}
	defer capture.Close()
	last := time.Now()
	lastMicCheck := time.Now()
	first := true
	readParent := ctx
	draining := false
	var drainCancel context.CancelFunc
	defer func() {
		if drainCancel != nil {
			drainCancel()
		}
	}()
	for {
		if !draining && ctx.Err() != nil {
			draining = true
			st.State = "stopping"
			writeStatus()
			readParent, drainCancel = context.WithTimeout(context.Background(), 2*time.Second)
			capture.End()
		}
		if !draining && st.AudioCodec != "" && time.Since(lastMicCheck) > time.Second {
			query, stop := context.WithTimeout(ctx, 2*time.Second)
			sources, e := streamconfig.AudioSources(query)
			stop()
			if ctx.Err() != nil {
				continue
			}
			if e != nil {
				return errors.New("microphone status unavailable; stream stopped")
			}
			if _, e = streamconfig.ResolveAudioSource(c.AudioSource, sources); e != nil {
				return e
			}
			if initialAudio != nil {
				for _, current := range sources {
					if current.Name == c.AudioSource && (current.ActivePort != initialAudio.ActivePort || current.SampleSpec != initialAudio.SampleSpec || current.ChannelMap != initialAudio.ChannelMap) {
						return errors.New("microphone format or route changed; stream stopped")
					}
				}
			}
			lastMicCheck = time.Now()
		}
		readCtx, stop := context.WithTimeout(readParent, 10*time.Second)
		data, e := capture.Read(readCtx)
		st.AudioProcessing = capture.AudioStats()
		stop()
		if e != nil {
			if draining {
				if conn, ok := dest.(srt.Conn); ok && errors.Is(e, io.EOF) {
					deadline := time.Now().Add(time.Second)
					for time.Now().Before(deadline) {
						var stats srt.Statistics
						conn.Stats(&stats)
						if stats.Instantaneous.PktSendBuf == 0 {
							break
						}
						time.Sleep(20 * time.Millisecond)
					}
				}
				return nil
			}
			if ctx.Err() != nil {
				continue
			}
			if errors.Is(e, context.DeadlineExceeded) {
				return errors.New("no encoded camera frames received for 10 seconds")
			}
			return e
		}
		if len(data)%188 != 0 {
			return errors.New("hardware pipeline produced invalid MPEG-TS packet alignment")
		}
		for len(data) > 0 {
			n, e := dest.Write(data[:min(len(data), 1316)])
			if e != nil {
				if ctx.Err() != nil {
					return nil
				}
				if errors.Is(e, errOutputCongested) {
					return e
				}
				return errors.New("SRT output disconnected")
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			data = data[n:]
			if b, ok := dest.(*bufferedOutput); ok {
				st.Bytes = b.sent.Load()
			} else {
				st.Bytes += uint64(n)
			}
		}
		if !draining {
			st.State = "sending"
		}
		if first || time.Since(last) > time.Second {
			writeStatus()
			last = time.Now()
			first = false
		}
	}
}
