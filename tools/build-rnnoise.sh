#!/bin/sh
# Build the small RNNoise model as an ARM64 sidecar for the Go streamer.
set -eu
out=${1:-build/rnnoise-arm64}
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [ ! -d "$out/source/.git" ]; then git clone https://github.com/xiph/rnnoise.git "$out/source"; fi
git -C "$out/source" checkout 70f1d256acd4b34a572f999a05c87bf00b67730d
(cd "$out/source" && sh download_model.sh)
cat > "$out/Dockerfile" <<'DOCKER'
FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross && rm -rf /var/lib/apt/lists/*
WORKDIR /work
DOCKER
printf '*\n!Dockerfile\n' > "$out/.dockerignore"
docker build -t action-control-audio-cross "$out"
docker run --rm -v "$out/source:/work" action-control-audio-cross aarch64-linux-gnu-gcc -O3 -fPIC -shared -Iinclude -Isrc src/denoise.c src/rnn.c src/pitch.c src/kiss_fft.c src/celt_lpc.c src/nnet.c src/nnet_default.c src/parse_lpcnet_weights.c src/rnnoise_data_little.c src/rnnoise_tables.c -o /work/librnnoise-small.so -lm
cp "$out/source/librnnoise-small.so" "$out/librnnoise-small.so"
cp "$out/source/COPYING" "$out/RNNOISE-LICENSE"
echo "Install $out/librnnoise-small.so and RNNOISE-LICENSE beside osmo-stream."
