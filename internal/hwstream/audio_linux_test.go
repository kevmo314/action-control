//go:build linux && (amd64 || arm64)

package hwstream

import (
	"math"
	"testing"
	"time"
)

func TestDelayedAudioKeepsCaptureTimeline(t *testing.T) {
	for _, mode := range []struct {
		name  string
		block uint64
		delay time.Duration
	}{{"dji", 1024, 128 * time.Millisecond}, {"rnnoise", 480, 20 * time.Millisecond}} {
		t.Run(mode.name, func(t *testing.T) {
			const rate = uint64(48000)
			const origin = uint64(170 * time.Millisecond)
			delaySamples := uint64(mode.delay) * rate / uint64(time.Second)
			inputBlocks := uint64(48000*60) / mode.block
			tailBlocks := delaySamples / mode.block
			var emitted uint64
			// Include the model's zero-input drain after the last captured block.
			for block := uint64(0); block < inputBlocks+tailBlocks; block++ {
				if (block+1)*mode.block <= delaySamples {
					continue
				}
				stamp := bufferTimes{pts: origin + block*mode.block*uint64(time.Second)/rate, dts: math.MaxUint64, duration: mode.block * uint64(time.Second) / rate}
				if err := compensateAudioTime(&stamp, mode.delay); err != nil {
					t.Fatal(err)
				}
				want := origin + emitted*mode.block*uint64(time.Second)/rate
				if stamp.pts != want || stamp.dts != math.MaxUint64 || stamp.duration != mode.block*uint64(time.Second)/rate {
					t.Fatalf("output %d: timestamp %+v, want PTS %d", emitted, stamp, want)
				}
				emitted++
			}
			if emitted != inputBlocks {
				t.Fatalf("lost audio tail: %d outputs for %d inputs", emitted, inputBlocks)
			}
		})
	}
}

func TestAudioTimestampUnderflow(t *testing.T) {
	for _, pts := range []uint64{math.MaxUint64, 1, uint64(127 * time.Millisecond)} {
		stamp := bufferTimes{pts: pts}
		if compensateAudioTime(&stamp, 128*time.Millisecond) == nil {
			t.Fatalf("accepted invalid PTS %d", pts)
		}
		if stamp.pts != pts {
			t.Fatal("invalid timestamp mutated")
		}
	}
	stamp := bufferTimes{pts: uint64(time.Second), dts: uint64(time.Second)}
	if err := compensateAudioTime(&stamp, 128*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if stamp.pts != uint64(872*time.Millisecond) || stamp.dts != stamp.pts {
		t.Fatal("PTS/DTS diverged")
	}
}
