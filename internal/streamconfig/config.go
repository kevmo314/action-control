// Package streamconfig connects the camera's frame source and hardware HEVC encoder
// to an application-owned SRT sender. It does not use DJI's livestream service.
package streamconfig

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

type Config struct {
	Address     string `json:"address"`
	StreamID    string `json:"stream_id"`
	Passphrase  string `json:"passphrase,omitempty"`
	LatencyMS   int    `json:"latency_ms"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrate_kbps"`
	AudioSource string `json:"audio_source"`
}

func DefaultConfig() Config {
	return Config{LatencyMS: 1000, Width: 1280, Height: 720, FPS: 30, BitrateKbps: 4000, AudioSource: "auto"}
}

func (c Config) Validate() error {
	if !ValidSourceName(c.AudioSource) {
		return errors.New("invalid microphone source name")
	}
	host, port, err := net.SplitHostPort(c.Address)
	p, e := strconv.Atoi(port)
	if err != nil || e != nil || host == "" || p < 1 || p > 65535 || strings.ContainsAny(host, " /\r\n\t") {
		return errors.New("destination must be a hostname or IP address and port, such as 192.168.1.10:9000")
	}
	if len(c.StreamID) > 512 || strings.ContainsAny(c.StreamID, "\x00\r\n") {
		return errors.New("stream ID must be at most 512 bytes without control characters")
	}
	if len(c.Passphrase) != 0 && (len(c.Passphrase) < 10 || len(c.Passphrase) > 79) {
		return errors.New("SRT passphrase must be empty or 10–79 bytes")
	}
	if c.LatencyMS < 20 || c.LatencyMS > 8000 {
		return errors.New("latency must be 20–8000 ms")
	}
	if !((c.Width == 1280 && c.Height == 720) || (c.Width == 1920 && c.Height == 1080)) {
		return errors.New("choose 1280×720 or 1920×1080")
	}
	if c.FPS != 25 && c.FPS != 30 {
		return errors.New("frame rate must be 25 or 30 fps")
	}
	if c.BitrateKbps < 500 || c.BitrateKbps > 30000 {
		return errors.New("bitrate must be 500–30000 kbps")
	}
	return nil
}

// Pipeline only interpolates validated integers, never URLs or credentials.
// Raw frames remain in the native pipeline; Go reads the encoded TS packets.
func (c Config) Pipeline(testPattern bool) string {
	source := "djiqmmfsrc camera=0"
	if testPattern {
		source = "videotestsrc is-live=true pattern=ball"
	}
	video := fmt.Sprintf("%s ! video/x-raw,format=NV12,width=%d,height=%d,framerate=%d/1 ! djicamc2venc control-rate=constant target-bitrate=%d idr-interval=%d b-frames=0 ! video/x-h265,stream-format=byte-stream,alignment=au ! h265parse config-interval=-1 ! queue max-size-buffers=16 ! mux. ", source, c.Width, c.Height, c.FPS, c.BitrateKbps*1000, c.FPS)
	audio := ""
	if c.AudioSource != "" && c.AudioSource != "none" && c.AudioSource != "auto" {
		audio = fmt.Sprintf("pulsesrc name=mic device=%s provide-clock=false client-name=osmo-stream ! queue max-size-buffers=16 ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2 ! avenc_aac bitrate=128000 ! aacparse ! queue max-size-buffers=16 ! mux. ", c.AudioSource)
	}
	return video + audio + "mpegtsmux name=mux alignment=7 ! appsink name=encoded sync=false max-buffers=8 drop=false wait-on-eos=false"
}
