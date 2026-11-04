package main

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	srt "github.com/datarhei/gosrt"
)

var errOutputCongested = errors.New("SRT receiver cannot keep up; lower the bitrate or improve the network")

// Drain the native appsink independently of network scheduling. The vendor
// encoder has a small output queue and must not be stalled by a slow SRT peer.
// At most 1024 transport packets (~1.3 MB) are buffered; congestion beyond that
// fails explicitly instead of growing memory or silently dropping TS packets.
type bufferedOutput struct {
	output io.WriteCloser
	queue  chan []byte
	done   chan struct{}
	mu     sync.Mutex
	closed bool
	err    error
	once   sync.Once
	sent   atomic.Uint64
	linger time.Duration
}

func newBufferedOutput(output io.WriteCloser, latency time.Duration) *bufferedOutput {
	b := &bufferedOutput{output: output, queue: make(chan []byte, 1024), done: make(chan struct{}), linger: latency}
	go func() {
		defer close(b.done)
		for data := range b.queue {
			for len(data) > 0 {
				n, err := output.Write(data)
				if n > 0 {
					b.sent.Add(uint64(n))
					data = data[n:]
				}
				if err == nil && n == 0 {
					err = io.ErrShortWrite
				}
				if err != nil {
					b.mu.Lock()
					b.err = err
					b.mu.Unlock()
					return
				}
			}
		}
	}()
	return b
}
func (b *bufferedOutput) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return 0, b.err
	}
	if b.closed {
		return 0, io.ErrClosedPipe
	}
	if len(data) > 1316 {
		return 0, errors.New("SRT transport packet exceeds 1316 bytes")
	}
	select {
	case b.queue <- append([]byte(nil), data...):
		return len(data), nil
	default:
		return 0, errOutputCongested
	}
}
func (b *bufferedOutput) Close() error {
	b.once.Do(func() {
		b.mu.Lock()
		b.closed = true
		close(b.queue)
		b.mu.Unlock()
		select {
		case <-b.done:
		case <-time.After(2 * time.Second):
			_ = b.output.Close()
		}
		if conn, ok := b.output.(srt.Conn); ok {
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				var stats srt.Statistics
				conn.Stats(&stats)
				if stats.Instantaneous.PktSendBuf == 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			// ACKed packets can still be waiting in the receiver's TSBPD queue.
			// Let them play out before sending the SRT shutdown handshake.
			time.Sleep(min(2*time.Second, b.linger+100*time.Millisecond))
		}
		_ = b.output.Close()
	})
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.err
}
