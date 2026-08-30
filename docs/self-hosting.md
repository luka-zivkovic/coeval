# Self-hosting and test-instance updates

## Status and support boundary

- **TARGET:** a Coeval release is an exact semantic version published as
  `ghcr.io/luka-zivkovic/coeval-{api,web}:X.Y.Z`, plus matching generic
  single-host and Coolify Compose bundles.
- **CURRENT:** the container workflow, `deploy/self-host/compose.yaml`, and
  `deploy/coolify.yaml` are present in the repository. They become installable
  after the next version tag publishes public GHCR packages. The existing
  `v0.1.0` predates these artifacts and must not be selected.
- **CURRENT:** founder-only deployments are disposable test instances. This
  pre-launch release supports clean database installs only; recreate the
  instance when the current baseline changes.
- **ASSUMPTION:** the default stack runs on one Coolify server, exposes only
  the nginx `web` service through TLS, and keeps the API and Postgres private.

## Generic single-host bundle

`deploy/self-host/compose.yaml` is the platform-neutral, release-owned bundle
for a Linux host with Docker Engine and Compose v2. It pins one exact Coeval
application version, exposes only the web service on loopback by default, and
persists Postgres in a named volume. `compose.yaml.sha256` is validated by the
release workflow so a tag cannot publish with a stale bundle checksum.

The separate pre-release `trustctl` CLI installs this bundle, generates the
required secrets, preserves operator additions in `compose.override.yaml`,
and provides `status`, `doctor`, update checking, and explicit updates. It is
not part of Coeval's runtime and receives no Docker or hosting credentials.
Its one-line bootstrap must not be advertised until the trustctl repository,
this bundle, and anonymously pullable images are all public.

Coolify remains a separate deployment method. Its control plane owns the
saved Compose and environment state; trustctl neither adopts nor updates a
Coolify Service.

## Coolify install

`deploy/coolify.yaml` is both the source for a future Coolify catalog template
and a template that can be pasted into **Docker Compose Empty** today.

1. Create a Docker Compose Empty Service in the target project/environment.
2. Paste `deploy/coolify.yaml` and save it.
3. Set `COEVAL_VERSION` to an exact published release such as `0.2.0`. Do not
   use `latest`, `main`, or another floating value.
4. Confirm Coolify generated the `SERVICE_URL_WEB`, Postgres password, auth
   secret, and bootstrap token. Do not replace those values during an update.
5. Deploy. The web component's health check traverses nginx to the API, while
   the API health check verifies the process and Postgres gates startup.
6. Open the generated web URL and complete owner setup.

Coolify copies a one-click template into each Service; later catalog changes
do not rewrite an existing instance. The saved Compose definition and its
environment values therefore remain the instance's update contract.

Official Coolify catalog publication is a distribution follow-up. Coolify's
current contribution policy requires the upstream repository to have at least
1,000 GitHub stars. That requirement does not prevent testing or operating the
same Compose definition as a user-defined Service.

## Release contract

Bump the root `package.json` version, merge it, and push the matching exact
`vX.Y.Z` tag. A mismatch fails the release before publishing. The workflow
runs the full build, typecheck, and test suite, verifies the generic Compose
checksum and render, then publishes amd64 and arm64 API/web images with:

- the immutable `X.Y.Z` tag used by operators;
- a `sha-<full commit>` traceability tag;
- OCI source, revision, and version metadata; and
- build provenance and an SBOM.

After every image publishes, the workflow pulls those exact tags into the
generic Compose bundle, boots a disposable stack, and verifies the public
health route. Only then does it create a **draft** GitHub release. After the
first workflow run, an owner must make both GHCR packages public; package
visibility persists for later versions. Verify an anonymous pull of both exact
tags, declare whether the current baseline changed, and publish the draft. Default
trustctl installs and update checks see only that published release, so the
draft is the release-readiness gate.

Every pre-launch release note must declare one of:

- **Baseline unchanged:** the founder-owned test instance may update images in
  place and may roll back to the prior exact image.
- **Baseline changed:** create a clean test instance; no in-place schema
  migration or downgrade is supported.

## Updating an instance

1. Read every release note between the installed and target versions.
2. If the baseline changed, create a clean Service and stop; do not attach the
   old Postgres volume.
3. If the baseline is unchanged, record the current Compose, exact image
   version, generated secrets, domain, and scheduled tasks.
4. Change both Coeval image references by changing the
   single `COEVAL_VERSION` value. Merge any release-specific Compose changes.
5. Deploy and verify `/health`, sign-in, project reads, and a background job.

Do not use Coolify's **Pull Latest Images & Restart** for Coeval. An exact
semantic-version tag is immutable, so a normal redeploy is sufficient. A
floating tag can silently combine a new application and a changed baseline.

## Backups and secrets

The Postgres component exposes the standard `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB` variables, allowing Coolify to create a
database-aware scheduled backup for the database inside the Service. Send a
copy to off-host S3-compatible storage and regularly restore into a disposable
database; a successful dump alone is not a recovery test.

`BETTER_AUTH_SECRET` also encrypts stored integration credentials. Losing or
changing it invalidates sessions and makes those credentials unreadable.
Preserve it in a separate secret-manager/instance-recovery record; do not put
it in the database backup itself.

Persistent volumes survive ordinary container replacement but are not
backups. Never delete or rename `coeval_postgres_data` as part of an update.

## Local image smoke test

Before publishing a release:

```sh
docker build -f apps/api/Dockerfile -t coeval-api:smoke .
docker build -f apps/web/Dockerfile -t coeval-web:smoke .
COEVAL_VERSION=0.2.0 docker compose -f deploy/coolify.yaml config >/dev/null
COEVAL_VERSION=0.2.0 \
  COEVAL_POSTGRES_PASSWORD=render-only \
  COEVAL_AUTH_SECRET=render-only-secret-at-least-32-bytes \
  docker compose -f deploy/self-host/compose.yaml config >/dev/null
```

Use the actual candidate version in the final command. The Compose render does
not prove GHCR visibility or database restore safety; verify both separately.
