package hwstream

import (
	"math"
	"testing"
	"time"
)

func TestStabilizationStartsOnSettledKeyframe(t *testing.T) {
	var g startupGate
	now := time.Unix(100, 0)
	const delta = uint32(1 << 13)
	if g.video(0, 0, now) || g.audio(0) {
		t.Fatal("frames released before metadata")
	}
	g.readyAfter.Store(now.Add(time.Second).UnixNano())
	if g.video(500_000_000, 0, now.Add(time.Millisecond*500)) {
		t.Fatal("warmup keyframe released")
	}
	if g.video(1_500_000_000, delta, now.Add(time.Second*2)) {
		t.Fatal("inter frame released without references")
	}
	if g.video(math.MaxUint64, 0, now.Add(time.Second*2)) {
		t.Fatal("untimestamped video released")
	}
	if !g.video(2_000_000_000, 0, now.Add(time.Second*2)) {
		t.Fatal("settled keyframe dropped")
	}
	if g.audio(1_990_000_000) || g.audio(math.MaxUint64) {
		t.Fatal("audio preceding video or missing PTS released")
	}
	if !g.audio(2_000_000_000) || !g.audio(2_020_000_000) {
		t.Fatal("aligned audio dropped")
	}
	if !g.video(2_033_333_333, delta, now.Add(time.Second*2)) {
		t.Fatal("subsequent inter frame dropped")
	}
	if g.video(math.MaxUint64, delta, now.Add(time.Second*3)) {
		t.Fatal("untimestamped active video released")
	}
	if g.videoPTS.Load() != 2_000_000_000 {
		t.Fatal("capture origin moved after startup")
	}
}

func TestStabilizationDrainsVideoToAudioEndpoint(t *testing.T) {
	var g startupGate
	g.videoEnd.Store(5_700_000_000)
	g.audioEnd.Store(6_000_000_000)
	if g.drained() {
		t.Fatal("EOS inferred while audio still capturing")
	}
	g.audioEOS.Store(true)
	if g.drained() {
		t.Fatal("delayed video cut before captured audio endpoint")
	}
	g.videoEnd.Store(6_010_000_000)
	if !g.drained() {
		t.Fatal("aligned video tail never completed")
	}
	var silent startupGate
	silent.audioEOS.Store(true)
	if !silent.drained() {
		t.Fatal("stop during warmup requires an encoded frame")
	}
}
