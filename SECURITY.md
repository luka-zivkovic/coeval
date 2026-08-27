# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's **Security → Report a vulnerability** flow on GitHub. Do not include credentials, customer traces, or exploit details in a public issue.

Include:

- the affected component and revision;
- reproduction steps or a minimal proof of concept;
- the expected security boundary;
- the practical impact; and
- any suggested mitigation.

You should receive an acknowledgement within seven days. A fix and disclosure timeline will depend on severity and reproducibility.

## Supported versions

Until Coeval reaches a stable release, security fixes target the latest revision of `main`. Older revisions are not maintained as separate supported release lines.

## Deployment guidance

For a networked deployment:

- use HTTPS and secure cookies;
- generate a strong, unique `BETTER_AUTH_SECRET` and protect it as encryption key material;
- prefer the UI's new-project-only, project-scoped, single-use 15-minute agent connections;
  revoke and regenerate one if its copied instructions may have leaked;
- set `COEVAL_TRUST_PROXY=1` only when direct API access is blocked and the
  trusted reverse proxy sanitizes forwarded client-IP headers;
- leave headless bootstrap disabled unless needed; when enabled, generate a
  separate strong `COEVAL_BOOTSTRAP_TOKEN`, share it only with trusted
  administrators, and rotate it after suspected exposure;
- restrict `TRUSTED_ORIGINS` to the exact web origins you operate;
- keep Postgres on a private network and maintain tested backups;
- use least-privilege provider and trace-platform credentials;
- configure trace exclusions and retention before importing production data;
- rotate any credential that may have appeared in logs or a trace payload; and
- review project membership before issuing browser or API access.

The repository's deterministic demo mode is for local evaluation only. It has no authentication or persistent storage and must not be exposed as a production service.
