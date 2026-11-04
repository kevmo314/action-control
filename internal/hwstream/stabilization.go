package hwstream

import (
	"math"
	"sync/atomic"
	"time"
)

// A single gate keeps video and audio on their capture timeline while the
// native EIS node changes from its initial settings to the requested mode.
// GStreamer calls these from separate audio/video streaming threads.
type startupGate struct {
	seen       atomic.Bool
	encoded    atomic.Uint64
	keyframes  atomic.Uint64
	readyAfter atomic.Int64
	videoPTS   atomic.Uint64
	opened     atomic.Bool
	videoEnd   atomic.Uint64
	audioEnd   atomic.Uint64
	audioEOS   atomic.Bool
}

func (g *startupGate) video(pts uint64, flags uint32, now time.Time) bool {
	if pts == math.MaxUint64 {
		return false
	}
	if g.opened.Load() {
		return true
	}
	deadline := g.readyAfter.Load()
	// GstBuffer DELTA_UNIT (1<<13) marks frames that need earlier references.
	if deadline == 0 || now.UnixNano() < deadline || pts == math.MaxUint64 || flags&(1<<13) != 0 {
		return false
	}
	g.videoPTS.Store(pts)
	g.opened.Store(true)
	return true
}
func (g *startupGate) audio(pts uint64) bool {
	return g.opened.Load() && pts != math.MaxUint64 && pts >= g.videoPTS.Load()
}

func (g *startupGate) drained() bool {
	return g.audioEOS.Load() && g.videoEnd.Load() >= g.audioEnd.Load()
}
