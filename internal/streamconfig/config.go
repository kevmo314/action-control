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
	Address      string `json:"address"`
	StreamID     string `json:"stream_id"`
	Passphrase   string `json:"passphrase,omitempty"`
	LatencyMS    int    `json:"latency_ms"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	FPS          int    `json:"fps"`
	BitrateKbps  int    `json:"bitrate_kbps"`
	AudioSource  string `json:"audio_source"`
	ImageMode    string `json:"image_mode,omitempty"`
	WindFilter   bool   `json:"wind_filter"`
	OverlayFrame string `json:"overlay_frame,omitempty"`
}

func DefaultConfig() Config {
	return Config{LatencyMS: 1000, Width: 1280, Height: 720, FPS: 30, BitrateKbps: 4000, AudioSource: "auto"}
}

func (c Config) Validate() error {
	switch c.ImageMode {
	case "", "standard", "10bit", "dlogm", "shdr", "lowlight":
	default:
		return errors.New("unsupported image mode")
	}
	if c.OverlayFrame != "" && (strings.ContainsAny(c.OverlayFrame, "\"\\\r\n\x00") || !strings.HasPrefix(c.OverlayFrame, "/")) {
		return errors.New("overlay frame must be an absolute local path")
	}
	if c.OverlayFrame != "" && (c.ImageMode == "10bit" || c.ImageMode == "dlogm") {
		return errors.New("browser overlays currently require an 8-bit image mode; disable the scene or select Standard")
	}
	if c.ImageMode != "" && c.ImageMode != "standard" && (c.Width != 1920 || c.Height != 1080 || c.FPS != 30) {
		return errors.New("advanced image modes currently require 1920×1080 at 30 fps")
	}
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
	if !((c.Width == 1280 && c.Height == 720) || (c.Width == 1920 && c.Height == 1080) || (c.Width == 2560 && c.Height == 1440)) {
		return errors.New("choose 1280×720, 1920×1080, or 2560×1440")
	}
	if c.FPS != 25 && c.FPS != 30 {
		return errors.New("frame rate must be 25 or 30 fps")
	}
	if c.BitrateKbps < 500 || c.BitrateKbps > 30000 {
		return errors.New("bitrate must be 500–30000 kbps")
	}
	return nil
}

// Pipeline interpolates validated settings and a quoted local renderer path.
// Network URLs and credentials stay outside the native pipeline.
// Raw frames remain in the native pipeline; Go reads the encoded TS packets.
func (c Config) Pipeline(testPattern bool) string {
	source := "djiqmmfsrc camera=0"
	if testPattern {
		source = "videotestsrc is-live=true pattern=ball"
	}
	format, colorimetry := "NV12", ""
	switch c.ImageMode {
	case "10bit":
		format, colorimetry = "P010_10LE", ",colorimetry=bt709"
	case "dlogm":
		format, colorimetry = "P010_10LE", ",colorimetry=bt709-dlogm"
	case "lowlight":
		if !testPattern {
			source += " op-mode=lowlight viull-enable=true"
		}
	case "shdr":
		if !testPattern {
			source += " shdr=true shdr-enable=true"
		}
	}
	overlay := ""
	if c.OverlayFrame != "" {
		overlay = fmt.Sprintf("gdkpixbufoverlay name=sceneoverlay location=\"%s\" overlay-width=%d overlay-height=%d ! ", c.OverlayFrame, c.Width, c.Height)
	}
	video := fmt.Sprintf("%s ! video/x-raw,format=%s,width=%d,height=%d,framerate=%d/1%s ! %sdjicamc2venc control-rate=constant target-bitrate=%d idr-interval=%d b-frames=0 ! video/x-h265,stream-format=byte-stream,alignment=au ! h265parse config-interval=-1 ! queue max-size-buffers=16 ! mux. ", source, format, c.Width, c.Height, c.FPS, colorimetry, overlay, c.BitrateKbps*1000, c.FPS)
	audio := ""
	if c.AudioSource != "" && c.AudioSource != "none" && c.AudioSource != "auto" {
		filter := ""
		if c.WindFilter {
			filter = "audiocheblimit mode=high-pass cutoff=180 poles=4 ripple=0.25 ! "
		}
		audio = fmt.Sprintf("pulsesrc name=mic device=%s provide-clock=false client-name=osmo-stream ! queue max-size-buffers=16 ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2 ! %savenc_aac bitrate=128000 ! aacparse ! queue max-size-buffers=16 ! mux. ", c.AudioSource, filter)
	}
	return video + audio + "mpegtsmux name=mux alignment=7 ! appsink name=encoded sync=false max-buffers=8 drop=false wait-on-eos=false"
}
