//go:build !linux || (!amd64 && !arm64)

package hwstream

import (
	"context"
	"errors"
)

type Capture struct{}

func Open(Config, bool) (*Capture, error) {
	return nil, errors.New("hardware capture requires Linux ARM64")
}
func (*Capture) Read(context.Context) ([]byte, error) {
	return nil, errors.New("hardware capture unavailable")
}
func (*Capture) Close() {}
func (*Capture) End()   {}

func (*Capture) AudioStats() ProcessorStats { return ProcessorStats{} }
