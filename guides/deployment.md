---
title: Running Tyr in a container
---

# Running Tyr in a container

## Published image

Since 0.36.0, each release is published to the GitHub Container Registry for
`linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/janbalangue/tyr-admission-controller:0.36.0
```

Each image is tagged with its exact version only; there is no `latest` tag.
It carries an SBOM and build provenance, which
`docker buildx imagetools inspect` lists alongside the two platforms.

Pin production deployments to a released version or image digest rather than a
mutable `latest` tag.

## Build the image yourself

```bash
docker build -t tyr-admission-controller:0.36.0 .
```

The source tree must include the committed `vendor/` directory. Run `npm run verify:vendor` before building or publishing a source archive.
It is an offline check: it proves each tarball matches the lockfile. Because a tarball and its lockfile entry can be regenerated together from a local `npm pack`, CI also runs `npm run verify:vendor-provenance`, which compares each vendored tarball against the artifact npm published for that exact `name@version`. That online check is what stops a local pre-release build from shipping under a released version number; run it whenever you re-vendor a dependency.

## Run it

Run the image with a read-only mounted configuration. A published image runs
the same way under its `ghcr.io` name:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  tyr-admission-controller:0.36.0
```

A configuration that uses `responsesState` also needs a writable mount for the
state file, because the configuration mount above is read-only.

## Compose

The repository includes a Compose example:

```bash
docker compose -f compose.example.yaml up --build
```

## Point a client at the container

An OpenAI SDK can point its base URL at `http://tyr:8787/v1` and use either
`responses.create(...)` or Chat Completions within the supported request boundary.
An Anthropic client can send Messages requests to `http://tyr:8787/v1/messages`.
In all cases, the application continues to own and send its provider credentials.
