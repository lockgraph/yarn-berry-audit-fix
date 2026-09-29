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
  qiwi/                             Original qiwi snapshots (ignored)
  corpus/                           Additional pinned monorepo snapshots (ignored)
  registry/                         Generated metadata and tarballs (ignored)
  audit/                            Generated advisory responses (ignored)
target/main/                        Compiled JavaScript and declarations
target/smoke/                       Compiled runtime smokes and copied fixtures
target/smoke-managers/              Standalone Yarn bundles for CI
```

## Fixtures

[provenance.json](resources/real-world/provenance.json) is the source of truth for every external fixture and the only tracked file in `resources/real-world/`. It pins GitHub commits, tarball URLs, package versions, registry request bodies, advisory IDs, and SHA-256 hashes.

[`build-fixtures.ts`](ts/build-fixtures.ts) downloads assets and verifies their expected hashes before saving them. GitHub files and tarballs are preserved byte for byte. Registry metadata is normalized to the declared package versions and installation fields; audit responses are reduced to declared advisory IDs. New releases and unrelated advisories do not affect the snapshots. Changes to pinned data fail verification instead of silently updating expectations.

Generated lockfiles, manifests, licenses, metadata, audit JSON, and tarballs are all ignored by Git. Valid cached assets are reused without network requests; missing or corrupt assets are downloaded by a pool of eight workers. On failure, the builder stops taking queued work and waits for active workers before rejecting. Tests read assets through provenance and verify their hashes. They never download fixtures implicitly.

A fresh checkout needs network access for dependency installation and fixture preparation. Once prepared, tests require no external network access, but integration tests must be able to bind a local HTTP server on `127.0.0.1`.

### Sources and registry replay

The corpus is selected from the real-world collections in yarn-audit-fix and lockgraph. All assets are fetched directly from immutable upstream commits; no local checkout of those tools is needed.

| Fixture | Upstream revision | Native schema |
| --- | --- | --- |
| `qiwi/masker` | [qiwi/masker](https://github.com/qiwi/masker/tree/1b3cf47948381e82cb775eb450cf7064b82c5d3d) | 8 |
| `qiwi/packasso` | [qiwi/packasso](https://github.com/qiwi/packasso/tree/74a5f9c1f3d47546d7062028b582763db04064b5) | 6 |
| `corpus/jest-26` | [jestjs/jest](https://github.com/jestjs/jest/tree/b254fd82fdedcba200e1c7eddeaab83a09bdaaef) | 4 |
| `corpus/berry-3` | [yarnpkg/berry](https://github.com/yarnpkg/berry/tree/8a82356039ae60f859daa8e6bda3ca681e7c2b0e) | 5 |
| `corpus/mware` | [qiwi/mware](https://github.com/qiwi/mware/tree/ed822d4d23737268917097a07e46b9ac559bed43) | 6 |
| `corpus/highlight` | [highlight/highlight](https://github.com/highlight/highlight/tree/7a297b5fea4233d99e92177f53dada3236513616) | 8 |
| `corpus/babel` | [babel/babel](https://github.com/babel/babel/tree/ae5796912c3c12e0913c40050c10adfb231aa811) | 9 |
| `corpus/jest-30` | [jestjs/jest](https://github.com/jestjs/jest/tree/4c3091b4204d703f4ebe343b8ac9d8a28ac4388e) | 10 |

The `project` records in provenance select the integration corpus, its native Yarn manager, and the dependencies retained for install tests. All eight full lockfiles are checked under both version-selection policies. A header round-trip must preserve the entire native file byte for byte, including plain legacy keys, long explicit YAML keys, patches, aliases, links, peer metadata, conditions, and checksums. This checks header handling separately from version selection; it does not simulate a full upstream installation.

Native monorepo cases retain the actual manifests' workspace paths, names, versions, dependency ranges, and links for selected Jest 26 and Yarn 3 workspaces. Unrelated dependencies and build hooks are removed from the test projection. The retained `glob` and `semver` dependency closures come from the original lockfiles and use genuine npm archives. Both node_modules and PnP are exercised, along with lockfile-only mode where the manager supports it, manifest restoration, installed versions, immutable installs, and idempotence. The full upstream applications are not built.

The existing qiwi subgraph matrix still covers every pinned CLI. The local registry reads all metadata, tarballs, and advisory responses from provenance; it replays the pinned `brace-expansion` and `semver` audit snapshots. The fixer invokes `yarn npm audit`, not a separate `npm audit` process.

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

The immutable install is a test oracle, not an extra install performed by the runtime fixer. Planning tests cover lowest/highest selection, separate ranges, prereleases, incompatible versions, all reported advisories, existing resolutions, and invalid policies. A native install checks that the highest policy is used when more than one stable fix qualifies. Header patch tests also cover combined descriptors, exact pins, obsolete ranges, record ordering, and inconsistent results. Fixture builder tests cover cache reuse, corruption, failed downloads, hash verification, and metadata/advisory normalization.

Peer-context edge cases, native build scripts, custom plugins, private registry authentication, and all supported Node/platform combinations are not comprehensively covered. A passing matrix does not replace the target application's tests.

## CI and runtime smokes

[The CI workflow](../../.github/workflows/ci.yml) runs the full suite on Linux with Node 24, then passes the compiled CLI, smoke harness, fixture assets, and standalone Yarn bundles to three smoke jobs:

| OS | Node | Check |
| --- | --- | --- |
| `ubuntu-latest` | `18.12.0` | Minimum supported runtime |
| `ubuntu-latest` | `latest` | Newest Node release |
| `windows-latest` | `latest` | Windows paths, process execution, and file restoration |

Smoke jobs install production dependencies only and run compiled JavaScript. They do not load Vitest/Vite or use native TypeScript stripping. The harness invokes the actual CLI with Yarn 2, 3, and 4, checks dry runs, both install modes, a nested workspace, byte-preserving restoration, installed versions, immutable installs, idempotence, and invalid flags. Yarn is invoked through explicit JavaScript bundle paths, so a preinstalled Yarn Classic cannot shadow the selected version.

To prepare and run the same smoke harness locally on the development Node version:

```sh
npm run build:test-fixtures
npm run build
npm run build:smoke
npm run test:smoke
```

Once prepared, `node target/smoke/test/ts/smoke.js` can run on an older Node without rebuilding. Fixtures are copied to the compiled helper's resource directory, and the Yarn bundles are copied to `target/smoke-managers/`.

## Releases

Pushes to `master` release only after the full suite and all three runtime smoke jobs pass. The release job uses the `release` GitHub environment, downloads the tested `target/main` artifact, and runs `npm run release` with Node 26. It does not install project dependencies or rebuild the package.

The pinned `zx-semrel` generates the version, changelog, release commit, tag, and GitHub release from conventional commits, then publishes to npm through OIDC and to GitHub Packages as `@lockgraph/yarn-berry-audit-fix`. The first release starts at `0.1.0`; later releases derive their version from stable Git tags. Organization variables supply `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`; `GIT_SIGN_KEY` signs the release commit and tag. GitHub authentication uses the workflow's `GITHUB_TOKEN`.

The npm trusted publisher must point to `lockgraph/yarn-berry-audit-fix`, workflow **`ci.yml`**, with direct `npm publish` allowed and no required environment. Publishing permissions and the signing secret are scoped to the release job. A final job checks the published package through `npx` and a global install on Node 18.12. PRs and manual workflow runs execute tests without publishing.
