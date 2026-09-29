# yarn-berry-audit-fix

[![Maintainability](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix/maintainability.svg)](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix)
[![Code Coverage](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix/coverage.svg)](https://qlty.sh/gh/lockgraph/projects/yarn-berry-audit-fix)
[![npm version](https://img.shields.io/npm/v/yarn-berry-audit-fix/latest?label=npm&color=blue)](https://www.npmjs.com/package/yarn-berry-audit-fix)

Fix vulnerable Yarn Berry dependencies with semver-compatible updates using temporary `resolutions` and Yarn's own install process. For a more comprehensive audit fixer, see [yarn-audit-fix](https://github.com/lockgraph/yarn-audit-fix).

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
```

| Option | Effect |
| --- | --- |
| `--dry-run` | Preview compatible fixes without installing or editing manifests or the lockfile. |
| `--policy=lowest\|highest` | Select the lowest (default) or highest newer stable version within each original range that avoids all reported vulnerabilities. |
| `--mode=update-lockfile` | Update the lockfile without linking or building. Requires Yarn 3+; rejected on Yarn 2. May download packages to the cache. |
| `--cwd DIR` | Use another project root. |
| `--json` | Print the report as JSON, including planned/applied changes, skipped requests, remaining advisories, and warnings. |
| `--yarn-path FILE` | Run a specific Yarn JavaScript bundle instead of `yarn` from PATH. |

By default, dependencies are installed. After a lockfile-only run, use `yarn install` when you want to update the installed tree.

Exit codes: `0` for a clean audit or dry run, `1` for remaining advisories, `2` for an execution error, `130` for interruption.

## API

```ts
import { fixAudit } from 'yarn-berry-audit-fix';

const report = await fixAudit({ cwd: '/path/to/project', dryRun: true, policy: 'highest' });
```

## How it works

The tool runs `yarn npm audit`, selects compatible fixes using the chosen policy, and adds temporary `resolutions`. Yarn performs one install. The original manifests are then restored, lockfile headers are patched back to their original ranges, and the audit runs again. Yarn's generated package records are preserved.

## Known limitations

- **Compatible npm ranges only.** Exact pins, aliases, special protocols, and ranges without a compatible fix are skipped. The tool does not widen ranges or search for parent upgrades to unlock a transitive fix.
- **Existing resolutions take priority.** Any package covered by a user resolution is skipped. Generated rules distinguish dependency ranges, but apply to all parents requesting the same range.
- **One repair pass.** Remaining or newly discovered advisories are reported, not automatically retried. Yarn 2/3 can miss versions when several versions of a package coexist; even exit code `0` may be incomplete. Warnings do not change the exit code.
- **Installation has side effects.** Yarn may change more of the lockfile than the planned fixes. The tool sets `YARN_ENABLE_SCRIPTS=false`; packages may need a separate build. Plugins and workspace hooks are not sandboxed.
- **Rollback has limits.** Handled failures restore manifests, lockfile, configuration, and saved install state, but not installed files or caches. Run `yarn install` after a failed regular install. A crash may require restoring adjacent `package.json-<sha256>.backup` files, recovering the lockfile from version control, and removing a stale `.yarn-berry-audit-fix.lock` after confirming no fixer is running.

Keep the project idle during a fix and run your application's tests afterward. Semver compatibility does not guarantee application compatibility.

For development, fixture preparation, and test coverage, see [src/test/README.md](src/test/README.md).

## License

[MIT](LICENSE)
