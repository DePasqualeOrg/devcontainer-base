#!/bin/bash
# Build on the Mini; --publish explicitly publishes both supported architectures to GHCR.
# Local builds retain their named image. This script never prunes another build's cache.
set -euo pipefail
cd "$(/usr/bin/dirname "$0")"
[[ $(cat "$HOME/.config/shell-role" 2>/dev/null) == build-host ]] || { echo 'Build this image on the Mini, not the laptop.' >&2; exit 1; }
tag=
publish=no
platform=
cache=()
for argument in "$@"; do
    case "$argument" in
        --publish) publish=yes ;;
        --platform=linux/arm64|--platform=linux/amd64)
            [[ -z "$platform" ]] || { echo "Specify one local platform." >&2; exit 64; }; platform=${argument#*=} ;;
        --no-cache) cache=(--no-cache) ;;
        --*) echo "Unknown option: $argument" >&2; exit 64 ;;
        *) [[ -z "$tag" ]] || { echo 'Specify one image tag.' >&2; exit 64; }; tag=$argument ;;
    esac
done
revision=$(git rev-parse HEAD)
tag=${tag:-${revision:0:12}}
[[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || { echo 'Invalid image tag.' >&2; exit 64; }
if [[ "$publish" == yes ]]; then
    [[ -z "$platform" ]] || { echo "Publication always includes both architectures; omit --platform." >&2; exit 64; }
    [[ -z $(git status --porcelain --untracked-files=all -- . ':!agent-mail') ]] || { echo 'Publish only a clean, reviewed revision.' >&2; exit 1; }
    echo "START publish reviewed revision $revision to ghcr.io/depasqualeorg/devcontainer-base:$tag"
    docker buildx build --builder on-demand --progress plain ${cache[@]+"${cache[@]}"} \
        --platform linux/arm64,linux/amd64 \
        --label "org.opencontainers.image.revision=$revision" \
        --tag "ghcr.io/depasqualeorg/devcontainer-base:$tag" \
        --tag ghcr.io/depasqualeorg/devcontainer-base:latest --push .
else
    platform=${platform:-linux/arm64}
    echo "START local $platform build revision $revision as devcontainer-base:$tag"
    docker buildx build --builder on-demand --progress plain ${cache[@]+"${cache[@]}"} \
        --platform "$platform" --label "org.opencontainers.image.revision=$revision" \
        --tag "devcontainer-base:$tag" --load .
fi
echo 'FINISH devcontainer-base build'
