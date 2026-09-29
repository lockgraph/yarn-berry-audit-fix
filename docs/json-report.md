# JSON report

```sh
yarn dlx --quiet yarn-berry-audit-fix --json > audit-fix.json
jq '{meta, status, summary, cves}' audit-fix.json
```

`--quiet` suppresses Yarn's own installation logs. The fixer's stdout contains one JSON object; progress and warnings go to stderr. Warnings are also included in the report. `--silent` suppresses all output, including JSON. Explicit `--help` and `--version` requests keep their usual text output.

For scheduled fixes and automated pull requests, see the [GitHub Actions example](github-actions.md).

Selected fields from an illustrative run:

```json
{
  "meta": {
    "schemaVersion": 1,
    "toolVersion": "0.4.0",
    "generatedAt": "2026-09-29T17:45:12.345Z"
  },
  "status": "unfixed",
  "summary": {
    "applied": 1,
    "planned": 0,
    "skipped": 1,
    "advisories": {
      "before": 2,
      "resolved": 1,
      "remaining": 1,
      "introduced": 0
    }
  },
  "cves": {
    "resolved": ["CVE-2025-5889"],
    "remaining": ["CVE-2025-10000"],
    "introduced": [],
    "complete": true
  }
}
```

## Metadata and compatibility

- `meta.schemaVersion` identifies the JSON contract, independently of the package version. Incompatible field removals, type changes, or meaning changes require a new schema version. Additive fields may appear within the same schema; consumers should ignore unknown fields.
- `meta.toolVersion` is the installed `yarn-berry-audit-fix` version, read at runtime.
- `meta.generatedAt` is the report generation time in ISO 8601 UTC, always ending in `Z`.

Successes, dry runs, execution errors, and interruptions all include this metadata. Object field order is not part of the contract.

## Changes and findings

| Field | Meaning |
| --- | --- |
| `status` | `clean` when the final audit has no advisories; `unfixed` when findings remain; `dry-run` for a preview. |
| `summary.applied`, `summary.planned`, `summary.skipped` | Counts of dependency requests, not unique package names. Multiple ranges of one package count separately. |
| `changes[]` | Applied changes, or proposed changes during dry runs. Includes `name`, `descriptor`, `from`, `to`, and resolved advisories for that request. `removed: true` means the request disappeared from the graph; `to` then retains the planned version. |
| `skipped[]` | Requests excluded during planning, with `name`, `descriptor`, `version`, and a human-readable `reason`. A skipped request can disappear indirectly when its parent is updated; consult the final `remaining` findings for the outcome. |
| `before[]`, `resolved[]`, `remaining[]`, `introduced[]` | Advisory records from the initial audit, absent from the final audit, present in the final audit, or newly observed in the final audit, respectively. Records are deduplicated by package and advisory identity. `summary.advisories` contains their counts. |
| `cves.resolved`, `cves.remaining`, `cves.introduced` | Sorted, unique CVE IDs derived from the initial and final audit records. A CVE is resolved only when it is absent from every remaining finding, including other branches or packages. |
| `cves.complete` | Whether every initial/remaining advisory has known CVE metadata. `false` means some IDs could not be determined; empty CVE arrays do not imply a clean audit. An advisory with a known absence of CVEs has `cves: []`. This flag describes metadata availability, not audit coverage. |
| `warnings[]` | Audit limitations and optional metadata lookup failures. |

Advisory records retain their package name, ID, affected range, and available CVE/GHSA IDs, severity, and CVSS metadata. A fix in `changes[].advisories` applies to that dependency request; it does not mean the advisory or CVE has disappeared from the whole project. Use the top-level `resolved` and `cves.resolved` for that distinction.

Comparisons reflect the selected audit source and its coverage. For complete coverage of coexisting npm versions on Yarn 2/3, use `--audit-registry=https://registry.npmjs.org`. A newly observed finding is not necessarily a vulnerability introduced by the update.

Existing result fields (`changed`, `dryRun`, `policy`, `yarnVersion`, and `resolutions`) remain available. `resolutions` describes temporary planning rules, not persistent manifest changes.

## Dry runs and failures

With `--dry-run --json`, `summary.applied` is zero, `summary.planned` counts proposed changes, and `remaining` describes the initial audit. `resolved`, `introduced`, `cves.resolved`, and `cves.introduced` are empty. Planned per-request fixes and their CVEs remain available in `changes[].advisories`; no final graph is predicted.

Execution failures return `meta`, `status: "error"`, and `error: { "message": "..." }`, without a success digest. Interruption uses `status: "interrupted"`. Neither status implies that an installation had no side effects.

Exit codes remain `0` for clean audits or dry runs, `1` for remaining advisories, `2` for execution errors, and `130` for interruption. `--ignore-unfixed` changes exit code `1` to `0` without changing `status: "unfixed"` or the findings.

## API

```ts
import { fixAudit, createJsonReport, type JsonReport } from 'yarn-berry-audit-fix';

const result = await fixAudit({ cwd: '/path/to/project' });
const report: JsonReport = await createJsonReport(result);
console.log(JSON.stringify(report));
```

The API formatter uses available advisory metadata and does not contact GitHub. The CLI additionally attempts to fill missing CVE/CVSS metadata for initial, remaining, and changed advisories, unless a custom audit registry is selected.
