#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
output=.build-tools/eis-rotation
mkdir -p "$output"
${CC:-cc} -std=c11 -O2 -Wall -Wextra -Werror -o "$output/metadata-test" \
 native/eis/preview_rotation_test.c native/gui/sha256.c -ldl -pthread
"$output/metadata-test"
PYTHONDONTWRITEBYTECODE=1 python3 native/eis/rollback_trial_test.py
if command -v "${ACTION_EIS_CC:-aarch64-linux-gnu-gcc}" >/dev/null 2>&1; then
 "${ACTION_EIS_CC:-aarch64-linux-gnu-gcc}" -std=c11 -O2 -fPIC -shared \
  -fvisibility=hidden -mbranch-protection=standard -Wall -Wextra -Werror \
  -Wl,-z,relro,-z,now,-z,nodelete -Wl,--no-undefined \
  -o "$output/libosmo_eis_preview_rotation.so" \
  native/eis/preview_rotation.c native/gui/sha256.c -ldl -pthread
else
 docker run --rm -v "$PWD:/src" -w /src osmo-audio-cross \
  aarch64-linux-gnu-gcc -std=c11 -O2 -fPIC -shared -fvisibility=hidden \
  -mbranch-protection=standard -Wall -Wextra -Werror \
  -Wl,-z,relro,-z,now,-z,nodelete -Wl,--no-undefined \
  -o "$output/libosmo_eis_preview_rotation.so" \
  native/eis/preview_rotation.c native/gui/sha256.c -ldl -pthread
fi
sha256sum "$output/libosmo_eis_preview_rotation.so"
