# Tests

Use **Node.js 22.12+** for development: the fixture builder uses native TypeScript stripping, and Vitest/Vite require a newer runtime than the published CLI. The compiled CLI and API require **Node.js 18.12+**, matching `@yarnpkg/parsers` and Yarn 4.

Run commands from the repository root:

```sh
npm ci
npm run check
```

`check` prepares fixtures, checks types, runs Vitest, and builds the package. To run individual steps:

```sh
npm run build:test-fixtures
npm test
npm run test:integration
npm run typecheck
npm run build
```

The compiled CLI can be used locally with `node target/main/cli.js --cwd /path/to/project --dry-run`.

## Layout

The project uses TypeScript, Vitest, and Maven-style source directories:

```text
src/main/ts/                         Implementation and CLI
src/test/ts/                         Tests, helpers, and fixture builder
src/test/resources/real-world/
  provenance.json                   Tracked sources, recipes, and hashes
  qiwi/                             Generated upstream files (ignored)
  registry/                         Generated metadata and tarballs (ignored)
  audit/                            Generated advisory responses (ignored)
target/main/                        Compiled JavaScript and declarations
```

## Fixtures

[provenance.json](resources/real-world/provenance.json) is the source of truth for every external fixture and the only tracked file in `resources/real-world/`. It pins GitHub commits, tarball URLs, package versions, registry request bodies, advisory IDs, and SHA-256 hashes.

[`build-fixtures.ts`](ts/build-fixtures.ts) downloads assets and verifies their expected hashes before saving them. GitHub files and tarballs are preserved byte for byte. Registry metadata is normalized to the declared package versions and installation fields; audit responses are reduced to declared advisory IDs. New releases and unrelated advisories do not affect the snapshots. Changes to pinned data fail verification instead of silently updating expectations.

Generated lockfiles, manifests, licenses, metadata, audit JSON, and tarballs are all ignored by Git. Valid cached assets are reused without network requests; missing or corrupt assets are downloaded again. Tests read assets through provenance and verify their hashes. They never download fixtures implicitly.

A fresh checkout needs network access for dependency installation and fixture preparation. Once prepared, tests require no external network access, but integration tests must be able to bind a local HTTP server on `127.0.0.1`.

### Sources and registry replay

Complete lockfiles, manifests, and licenses come from pinned revisions of:

- [qiwi/masker](https://github.com/qiwi/masker/tree/1b3cf47948381e82cb775eb450cf7064b82c5d3d)
- [qiwi/packasso](https://github.com/qiwi/packasso/tree/74a5f9c1f3d47546d7062028b582763db04064b5)

Planning tests use the complete upstream lockfiles. Native install tests extract a small `minimatch → brace-expansion → balanced-match/concat-map` subgraph using the original records and checksums, then prepare it with the selected Yarn CLI. The complete upstream monorepos are not built or tested.

The local registry serves genuine npm tarballs and replays a saved advisory snapshot for `brace-expansion`. This registry protocol is used by `yarn npm audit`; the fixer does not invoke a separate `npm audit` process.

## Yarn matrix

Managers are pinned as npm aliases in root `devDependencies` and listed in [`pm.ts`](ts/pm.ts). `npm ci` installs them locally; no global Yarn installation is required.

| Yarn CLI | Lockfile schema | Regular install | `--mode=update-lockfile` |
| --- | --- | --- | --- |
| 2.4.3 | 4 | Yes | Rejected |
| 3.1.1 | 5 | Yes | Yes |
| 3.8.7 | 6 | Yes | Yes |
| 4.2.2, 4.13.0 | 8 | Yes | Yes |
| 4.14.1 | 9 | Yes | Yes |
| 4.18.1 | 10 | Yes | Yes |

Aliases such as `pm-yarn-berry-v5` refer to the lockfile schema, not the Yarn CLI major version. Each CLI produces its native format; integration tests assert `__metadata.version` before and after fixing.

The runtime accepts stable Berry releases from 2.4 through 4.x, excluding 4.0.0 because of its audit JSON bug. The accepted range is broader than this pinned test matrix. Yarn 2 must reject lockfile-only mode before auditing or mutating files.

## Checks and coverage

Integration tests cover root projects and workspaces, multiple semver branches, `node_modules` and PnP installations, both install modes, existing installed trees, idempotence, incompatible pins, and rollback on failure. They also capture Yarn 2/3 audit omissions when multiple versions of a package coexist.

For each successful fix, checks verify:

- Exactly one install during the fix, followed by another audit.
- Original manifest bytes and file identity restored through adjacent backups.
- Yarn-generated package record bodies preserved while headers regain the original dependency ranges.
- A subsequent native `install --immutable` leaves the lockfile byte-for-byte unchanged; Yarn 4 also uses `--check-resolutions`.

The immutable install is a test oracle, not an extra install performed by the runtime fixer. Header patch tests also cover combined descriptors, exact pins, obsolete ranges, record ordering, and inconsistent results. Fixture builder tests cover cache reuse, corruption, failed downloads, hash verification, and metadata/advisory normalization.

Peer-context edge cases, native build scripts, custom plugins, private registry authentication, and all supported Node/platform combinations are not comprehensively covered. A passing matrix does not replace the target application's tests.

Last full verification: 2026-09-29, Node 24.13.1. `npm run check` passed 103 tests, type checking, and the build. All 21 external assets were rebuilt from provenance and verified; a repeated fixture build reused the cache. The compiled CLI was also checked for help, unknown mode rejection, and Yarn 2 lockfile-only rejection without input changes.
