# Scheduled dependency fixes

Copy [yarn-audit-fix.yml](examples/yarn-audit-fix.yml) to `.github/workflows/yarn-audit-fix.yml` in your repository. The schedule runs on Mondays at 06:23 UTC; manual runs use the default branch.

Permissions are declared on each job: `fix` has `contents: read`; `publish` has `contents: write` and `pull-requests: write`. The publisher receives the lockfile and description through an artifact and runs only Git and `gh` commands.

The workflow uses the automatically provided `GITHUB_TOKEN`; no extra token or secret is needed. `GH_TOKEN: ${{ github.token }}` makes that token available to `gh`. Enable **Allow GitHub Actions to create and approve pull requests** under **Settings → Actions → General → Workflow permissions** ([GitHub settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).

- The ordinary fixer output becomes the PR description, inside a code block.
- Both the PR title and commit message are `chore: apply yarn-berry-audit-fix`.
- The branch is `ybaf/<sha256 of the original yarn.lock>` (full Git ref: `refs/heads/ybaf/<hash>`). GitHub rejects branch names beginning with `refs/`. The hash is taken immediately after checkout, before any changes. The publisher finds an open PR by this branch name, force-pushes the new commit, and updates its description. If there is no open PR, it creates one. The prefix belongs to the bot, so existing branches are overwritten with `--force`.
- The publisher rebases only its lockfile commit onto the latest `origin/<default branch>`. Tests belong to the repository's PR pipeline.

`--ignore-unfixed` allows partial fixes. Execution errors and rebase conflicts stop publication. No lockfile changes means no PR.

Use a supported Yarn version through `packageManager` or `yarnPath`; adjust Node 24 for your project. The example transfers and commits only `yarn.lock`. Add explicit paths if you also track Yarn caches or generated PnP files.

The same pattern works with `npm audit fix`: hash the original `package-lock.json`, capture stdout as the description, and transfer the files it changes to the publisher. The PR pipeline handles tests in either case.

PR checks created by `GITHUB_TOKEN` require a user with write access to select **Approve workflows to run** on the PR. A GitHub App token or PAT is needed only if those checks must start automatically without approval ([GitHub triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)).
