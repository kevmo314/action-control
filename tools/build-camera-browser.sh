#!/bin/sh
# Build a private ARM64 musl root. Never install these libraries into camera /usr.
set -eu
out=${1:-build/camera-browser}
mkdir -p "$out/apks" "$out/root"
out=$(cd "$out" && pwd)
# Alpine includes architecture-specific repository keys. apk verifies packages.
docker run --rm -v "$out/apks:/out" alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a sh -ec '
 cp /usr/share/apk/keys/aarch64/* /etc/apk/keys/
 apk fetch --arch aarch64 --recursive --output /out chromium-headless-shell
'
python3 - "$out" <<'PY'
import hashlib, pathlib, sys, tarfile
out=pathlib.Path(sys.argv[1])
manifest=[]
for package in sorted((out/'apks').glob('*.apk')):
    manifest.append(hashlib.sha256(package.read_bytes()).hexdigest()+'  '+package.name)
    with tarfile.open(package,'r:gz',ignore_zeros=True) as archive:
        files=[m for m in archive.getmembers() if not m.name.startswith('.')]
        archive.extractall(out/'root', members=files, filter='fully_trusted')
(out/'packages.sha256').write_text('\n'.join(manifest)+'\n')
PY
# Signatures and .PKGINFO are package metadata, not files for the chroot root.
# Keep APKs and manifest alongside the output for provenance and redistribution.
tar -C "$out/root" -cf "$out/browser-root.tar" .
echo "Built $out/browser-root.tar; see docs/STUDIO.md for installation."
