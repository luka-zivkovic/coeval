# ADR-0012: Rename Coeval to Rubrist

Status: **Accepted**

Date: 2026-09-22

Decision owner: Luka Živković (founder), explicit approval on 2026-09-22.

## Context

The product was launched in development as **Coeval**. A name conflict was
found with Coval (coval.ai), a funded AI-evaluation company. The two names
differ by one letter and describe products in the same category, so users,
search results, and partners would confuse them. The product is pre-launch:
it has no external users, no external consumers of its evidence contracts,
and only disposable founder test databases (ADR-0011).

## Decision

The product is renamed **Rubrist**. Every occurrence of the product name
changes case-preservingly in normative code, configuration, contracts,
fixtures, and current documentation:

| From | To |
| --- | --- |
| `Coeval` | `Rubrist` |
| `coeval` | `rubrist` |
| `COEVAL` | `RUBRIST` |

This covers prose, code identifiers, file and directory names, npm package
names (`rubrist`, `@rubrist/*`), environment variables (`RUBRIST_*`), contract
IDs, canonicalization and digest domain labels, token and key prefixes
(`rubrist_sk_`, `rubrist_pair_`), database names and roles, container image
names, the MCP server name, the Claude Code plugin and marketplace name
(`rubrist`), and the `rubrist-setup` and `rubrist-audit` skills.

### Contract IDs are renamed in place without aliases

Evidence contract IDs change from `coeval/<name>/v<n>` to
`rubrist/<name>/v<n>` with the same version number, and canonicalization
labels change the same way. No alias or dual-read path is kept for the old
IDs: there are no external consumers, and ADR-0011 already makes every
database a disposable blank-slate install. Fixture digests that depend on the
renamed bytes are regenerated with the repository's own digest code rather
than hand-edited. This is a one-time pre-launch exception to ADR-0001's
rule that changing a closed contract requires a new contract version and a
coordinated compatibility window; after launch a contract ID change follows
ADR-0001. Consumers that pin schema or fixture digests update those pins in
the same coordinated change.

### Releases

Container images are published as
`ghcr.io/luka-zivkovic/rubrist-api` and `ghcr.io/luka-zivkovic/rubrist-web`
from the next release. Already-published `0.2.0` artifacts keep their former
names and are not republished.

### Lockstep consumer update

Dailies vendors Rubrist's evidence contracts byte-identically. It applies the
same rename rule in the same change set, so the vendored `contracts/` files
and their fixtures stay byte-identical to this repository's. Ironside,
Casefile, Trialyard, Overclock, and the website update their references to
the product, its URLs, and its environment variables (for example
`IRONSIDE_RUBRIST_URL`) in the same coordinated batch. Ironside, Dailies,
Casefile, Trialyard, and Overclock keep their names.

## Consequences

- Old contract IDs, token prefixes, and environment variables stop working;
  test instances are recreated per ADR-0011.
- GitHub redirects the former repository URL after the owner renames the
  repository.
- Historical records (dated experiment and verification records, files that
  mark themselves historical, and git history) keep the former name.
- The website domain is not yet chosen; the package homepage points to the
  GitHub repository until it is.
