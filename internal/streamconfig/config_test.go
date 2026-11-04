package streamconfig

import "testing"

func TestRejectInvalidStreamSettings(t *testing.T) {
	base := DefaultConfig()
	base.Address = "[::1]:9000"
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Config){
		"URL instead of address": func(c *Config) { c.Address = "srt://receiver:9000?mode=caller" },
		"missing port":           func(c *Config) { c.Address = "receiver" },
		"port out of range":      func(c *Config) { c.Address = "receiver:65536" },
		"short key":              func(c *Config) { c.Passphrase = "short" },
		"unbounded latency":      func(c *Config) { c.LatencyMS = 999999 },
		"unsupported capture":    func(c *Config) { c.Width = 4096 },
		"pipeline injection":     func(c *Config) { c.AudioSource = "regular0 ! filesink location=/etc/config" },
	} {
		t.Run(name, func(t *testing.T) {
			c := base
			change(&c)
			if c.Validate() == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestMicrophoneDiscoveryAndSelection(t *testing.T) {
	fixture := `Source #1
 State: RUNNING
 Name: low-latency0.monitor
 Description: output monitor
Source #3
 State: RUNNING
 Name: regular0
 Description: internal microphones
 Sample Specification: s24-32le 4ch 48000Hz
 Channel Map: front-left,front-right,side-left,side-right
 Mute: no
 Active Port: handset-mic
Source #19
 State: SUSPENDED
 Name: source.wireless-mic
 Description: wireless mic input
 Sample Specification: s16le 2ch 48000Hz
 Channel Map: front-left,front-right
 Mute: yes
 Active Port: wireless-mic
`
	sources := ParseAudioSources(fixture)
	if len(sources) != 2 {
		t.Fatalf("monitor included or mic missing: %+v", sources)
	}
	if !sources[1].Wireless || !sources[1].Muted || sources[1].ChannelMap != "front-left,front-right" {
		t.Fatalf("wireless metadata lost: %+v", sources[1])
	}
	if selected, err := ResolveAudioSource("auto", sources); err != nil || selected != "source.wireless-mic" {
		t.Fatalf("auto did not prefer connected DJI mic: %s %v", selected, err)
	}
	withGenericBluetooth := append([]AudioSource{{Name: "bluez_source.generic", Wireless: true}}, sources...)
	if selected, err := ResolveAudioSource("auto", withGenericBluetooth); err != nil || selected != "source.wireless-mic" {
		t.Fatalf("generic Bluetooth input displaced DJI input: %s %v", selected, err)
	}
	if selected, err := ResolveAudioSource("regular0", sources); err != nil || selected != "regular0" {
		t.Fatalf("explicit selection ignored: %s %v", selected, err)
	}
	if selected, err := ResolveAudioSource("auto", sources[:1]); err != nil || selected != "regular0" {
		t.Fatalf("internal auto selection: %s %v", selected, err)
	}
	if _, err := ResolveAudioSource("source.wireless-mic", sources[:1]); err == nil {
		t.Fatal("disconnected selected mic silently fell back")
	}
	if _, err := ResolveAudioSource("auto", nil); err == nil {
		t.Fatal("missing input accepted")
	}
	if selected, err := ResolveAudioSource("none", nil); err != nil || selected != "none" {
		t.Fatal("video-only mode requires a microphone")
	}
}

func TestAdvancedModeHandoffConstraints(t *testing.T) {
	c := DefaultConfig()
	c.Address = "receiver:9000"
	c.Width = 1920
	c.Height = 1080
	c.ImageMode = "10bit"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.OverlayFrame = "/tmp/scene.png"
	if c.Validate() == nil {
		t.Fatal("known P010 overlay stall configuration accepted")
	}
	c.OverlayFrame = ""
	c.Width = 2560
	c.Height = 1440
	if c.Validate() == nil {
		t.Fatal("untested advanced resolution accepted")
	}
	c.ImageMode = "standard"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.ImageMode = "guessed-vendor-mode"
	if c.Validate() == nil {
		t.Fatal("unknown processing mode accepted")
	}
}

func TestNeuralProcessingNeverTakesWirelessChannels(t *testing.T) {
	for _, mode := range []string{"dji", "rnnoise"} {
		c := DefaultConfig()
		c.Address = "receiver:9000"
		c.NoiseReduction = mode
		c.AudioSource = "regular0"
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
		for _, source := range []string{"source.wireless-mic", "bluez_source.generic", "none"} {
			c.AudioSource = source
			if c.Validate() == nil {
				t.Fatalf("%s accepted %s", mode, source)
			}
		}
	}
}

func TestStabilizationProfilesRejectIncompatibleCapture(t *testing.T) {
	c := DefaultConfig()
	c.Address = "receiver:9000"
	for _, mode := range []string{"rocksteady", "horizonsteady", "horizonbalancing"} {
		c.Stabilization = mode
		for _, size := range [][2]int{{1280, 720}, {1920, 1080}, {2560, 1440}} {
			c.Width, c.Height = size[0], size[1]
			if err := c.Validate(); err != nil {
				t.Fatal(err)
			}
		}
		c.FPS = 25
		if c.Validate() == nil {
			t.Fatal("unverified stabilized sensor timing allowed")
		}
		c.FPS = 30
		c.ImageMode = "shdr"
		if c.Validate() == nil {
			t.Fatal("unverified stabilization/HDR graph allowed")
		}
		c.ImageMode = ""
	}
	c.Stabilization = "eis"
	if c.Validate() == nil {
		t.Fatal("generic EIS incorrectly accepted as DJI stabilization")
	}
}
