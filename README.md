# yarn-berry-audit-fix

[![Maintainability](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix/maintainability.svg)](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix)
[![Code Coverage](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix/coverage.svg)](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix)
[![npm version](https://img.shields.io/npm/v/yarn-berry-audit-fix/latest?label=npm&color=blue)](https://www.npmjs.com/package/yarn-berry-audit-fix)

Fix vulnerable Yarn Berry dependencies with semver-compatible updates using Yarn's own resolution and install process. For a more comprehensive audit fixer, see [yarn-audit-fix](https://github.com/lockgraph/yarn-audit-fix).

## TL;DR

Run from your project's root:

```sh
yarn dlx yarn-berry-audit-fix
```

Requires **Node.js 18.12+** and stable **Yarn 2.4+, 3.x, or 4.x** (except 4.0.0). Yarn Classic and Yarn 5+ are unsupported. The project must already have a Berry `yarn.lock`.

## Options

```sh
yarn dlx yarn-berry-audit-fix --dry-run
yarn dlx yarn-berry-audit-fix --policy=highest
yarn dlx yarn-berry-audit-fix --mode=update-lockfile
yarn dlx yarn-berry-audit-fix --audit-registry=https://registry.npmjs.org
yarn dlx yarn-berry-audit-fix --ignore-unfixed
yarn dlx --quiet yarn-berry-audit-fix --json > audit-fix.json
```

| Option | Effect |
| --- | --- |
| `--dry-run` | Change no project files; print a digest of planned fixes, affected packages, skipped requests, and initial advisories. No install is performed. |
| `--policy=lowest\|highest` | Select the lowest (default) or highest newer stable version within each original range that avoids all reported vulnerabilities. |
| `--mode=update-lockfile` | Update the lockfile without linking or building. Requires Yarn 3+; rejected on Yarn 2. May download packages to the cache. |
| `--audit-registry URL` | Send project and candidate audits directly to this registry using the bulk API. Works with Yarn 2/3/4; metadata and downloads keep their existing registry settings. |
| `--cwd DIR` | Use another project root. |
| `--json` | Print a versioned digest with tool version, UTC timestamp, changes, skips, resolved/remaining CVEs, and warnings. Errors also produce JSON. |
| `--silent` | Write nothing to stdout or stderr, including errors. Overrides JSON, help, version, and dry-run output; exit codes stay unchanged. |
| `--ignore-unfixed` | Exit successfully when advisories remain. Keeps the findings visible; execution errors and interruption still fail. |
| `--yarn-path FILE` | Run a specific Yarn JavaScript bundle instead of `yarn` from PATH. |
| `--help`, `-h` | Show command help without accessing a project. |
| `--version`, `-v` | Print the installed tool version without accessing a project. |

By default, dependencies are installed. After a lockfile-only run, use `yarn install` when you want to update the installed tree.

`--audit-registry` takes a base URL; requests go to `/-/npm/v1/security/advisories/bulk`. Without it, project audits use Yarn first and fall back to the public npm bulk API if Yarn fails. Proposed versions are always checked through bulk before installation, including during dry runs, using the override or public npm registry. Direct project audits include every locked npm version, including aliases and patched npm packages. Direct requests do not read Yarn registry settings or credentials.

Exit codes: `0` for a clean audit, dry run, or `--ignore-unfixed`; `1` for remaining advisories; `2` for an execution error; `130` for interruption. `--ignore-unfixed` only suppresses code `1`.

For automation, see the [JSON report format](docs/json-report.md). Stdout contains one JSON object; progress goes to stderr. `--dry-run --json` reports planned changes without claiming any CVEs have been resolved.

[GitHub Actions example](docs/github-actions.md): scheduled fixes, `yarn dedupe`, and a pull request with the fixer output as its description.

Each bump lists the advisories it resolves, with CVE IDs and CVSS scores when available. The CLI supplements missing metadata from GitHub's public Advisory API; a custom `--audit-registry` uses only its supplied metadata. CVSS is displayed only alongside CVE IDs; findings without a CVE show their GHSA ID alone. Unknown CVE scores are shown as unavailable. Failed supplementary lookups produce warnings without failing the repair.

## API

```ts
import { fixAudit } from 'yarn-berry-audit-fix';

const report = await fixAudit({
  cwd: '/path/to/project',
  dryRun: true,
  policy: 'highest',
  auditRegistry: 'https://registry.npmjs.org', // Optional; bypasses native Yarn audit.
});

// Each change includes its resolved advisories and metadata supplied by the audit source.
console.log(report.changes[0]?.advisories);
```

## How it works

The tool audits dependencies and selects compatible fixes using the chosen policy. It audits the proposed versions and replans if they have additional vulnerabilities. A temporary plugin passes the complete plan to Yarn through resolution aliases, then Yarn performs one install and writes the complete lockfile. The project is audited again. No plugin configuration or manifest resolutions are added to the project.

## Known limitations

- **Compatible npm ranges only.** Default and named Yarn catalogs are supported when they reference npm semver ranges. Exact pins, aliases, other special protocols, and ranges without a compatible fix are skipped. The tool does not widen ranges or search for parent upgrades to unlock a transitive fix.
- **Existing resolutions take priority.** Any package covered by a user resolution is skipped. Generated rules distinguish dependency ranges, but apply to all parents requesting the same range.
- **Updates can leave duplicate packages.** A new transitive version may coexist with an older locked version even when their ranges overlap. Duplicate instances can break shared state, such as React Router contexts. Run `yarn dedupe` after applying fixes, then test your application. Use `yarn dedupe --check` to detect deduplicable packages without changing files.
- **One install per run.** Findings in the final dependency graph are reported without another install. Native Yarn 2/3 audits can miss versions when several coexist; use `--audit-registry=https://registry.npmjs.org` to audit all locked npm versions directly. Bulk audit excludes workspace, Git, and other non-npm sources. Warnings do not change the exit code.
- **Installation has side effects.** Yarn may change more of the lockfile than the planned fixes. The tool sets `YARN_ENABLE_SCRIPTS=false`; packages may need a separate build. Plugins and workspace hooks are not sandboxed.
- **Rollback has limits.** Handled failures restore manifests, lockfile, configuration, and saved install state, but not installed files or caches. Run `yarn install` after a failed regular install. A crash may require restoring adjacent `package.json-<sha256>.backup` files, recovering the lockfile from version control, and removing a stale `.yarn-berry-audit-fix.lock` after confirming no fixer is running.

Keep the project idle during a fix and run your application's tests afterward. Semver compatibility does not guarantee application compatibility.

For development, fixture preparation, and test coverage, see [src/test/README.md](src/test/README.md).

## License

[MIT](LICENSE)
