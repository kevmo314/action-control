package streamconfig

import (
	"context"
	"errors"
	"os/exec"
	"strings"
)

type AudioSource struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	State       string `json:"state"`
	SampleSpec  string `json:"sample_spec"`
	ChannelMap  string `json:"channel_map"`
	ActivePort  string `json:"active_port"`
	Wireless    bool   `json:"wireless"`
	Muted       bool   `json:"muted"`
}

func ValidSourceName(name string) bool {
	if len(name) > 128 {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}

// The camera's pactl predates JSON output. Read the fixed English source
// fields rather than assuming that every input is ALSA or generic Bluetooth.
func ParseAudioSources(text string) []AudioSource {
	all := []AudioSource{}
	var source *AudioSource
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Source #") {
			all = append(all, AudioSource{})
			source = &all[len(all)-1]
			continue
		}
		if source == nil {
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		switch key {
		case "Name":
			source.Name = value
		case "Description":
			source.Description = value
		case "State":
			source.State = value
		case "Sample Specification":
			source.SampleSpec = value
		case "Channel Map":
			source.ChannelMap = value
		case "Active Port":
			source.ActivePort = value
		case "Mute":
			source.Muted = value == "yes"
		}
	}
	result := []AudioSource{}
	for _, s := range all {
		if s.Name == "" || !ValidSourceName(s.Name) || strings.HasSuffix(s.Name, ".monitor") {
			continue
		}
		s.Wireless = s.Name == "source.wireless-mic" || strings.Contains(s.Name, "wireless-mic") || strings.HasPrefix(s.Name, "bluez_source.")
		result = append(result, s)
	}
	return result
}

func AudioSources(ctx context.Context) ([]AudioSource, error) {
	cmd := exec.CommandContext(ctx, "pactl", "list", "sources")
	cmd.Env = append(cmd.Environ(), "LC_ALL=C", "LANG=C")
	data, err := cmd.Output()
	if err != nil {
		return nil, errors.New("cannot list camera microphones from PulseAudio")
	}
	return ParseAudioSources(string(data)), nil
}

func ResolveAudioSource(selection string, sources []AudioSource) (string, error) {
	if selection == "none" || selection == "" {
		return "none", nil
	}
	if selection == "auto" {
		for _, s := range sources {
			if s.Name == "source.wireless-mic" || strings.Contains(s.Name, "wireless-mic") {
				return s.Name, nil
			}
		}
		for _, s := range sources {
			if s.Name == "regular0" {
				return s.Name, nil
			}
		}
		if len(sources) == 1 {
			return sources[0].Name, nil
		}
		return "", errors.New("no unambiguous microphone is available; select an input explicitly")
	}
	for _, s := range sources {
		if s.Name == selection {
			return s.Name, nil
		}
	}
	return "", errors.New("selected microphone is disconnected; choose a connected input")
}
