package main

import (
	"bytes"
	"io"
	"testing"
)

type gatedOutput struct {
	bytes.Buffer
	gate chan struct{}
}

func (o *gatedOutput) Write(p []byte) (int, error) { <-o.gate; return o.Buffer.Write(p) }
func (*gatedOutput) Close() error                  { return nil }

func TestBufferedOutputOwnsPacketsAndDrains(t *testing.T) {
	o := &gatedOutput{gate: make(chan struct{})}
	b := newBufferedOutput(o, 0)
	packet := []byte("original payload")
	if _, err := b.Write(packet); err != nil {
		t.Fatal(err)
	}
	copy(packet, []byte("changed payload!"))
	close(o.gate)
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	if got := o.String(); got != "original payload" {
		t.Fatalf("packet data changed before transmission: %q", got)
	}
	if b.sent.Load() != uint64(len("original payload")) {
		t.Fatal("sent counter does not reflect underlying writes")
	}
	if _, err := b.Write([]byte("late")); err != io.ErrClosedPipe {
		t.Fatalf("write after close: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestBufferedOutputBoundsSlowReceiver(t *testing.T) {
	o := &gatedOutput{gate: make(chan struct{})}
	b := newBufferedOutput(o, 0)
	var failed bool
	for i := 0; i < 1100; i++ {
		if _, err := b.Write(make([]byte, 1316)); err != nil {
			failed = true
			break
		}
	}
	close(o.gate)
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	if !failed {
		t.Fatal("stalled receiver allowed unbounded queued data")
	}
}
