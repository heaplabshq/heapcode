import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { runGh, type GhResult } from '@heapcode/core';

/**
 * Heap QA on pull requests, through the same `gh auth login` session (and
 * the same `runGh`) as Heap Code's PR review.
 *
 * One comment per pull request, updated on every run: it carries a hidden
 * marker, and only a comment with that marker is ever edited — never anyone
 * else's, and never the person's own other comments, which is what `gh pr
 * comment --edit-last` would have risked.
 */

export const COMMENT_MARKER = '<!-- heapqa-report -->';

export type Gh = (args: string[], cwd: string, stdin?: string) => Promise<GhResult>;

export interface PullRequest {
  number: number;
  title: string;
  url: string;
}

/** The current branch's pull request (or number `pr`), or why there is none. */
export async function findPullRequest(cwd: string, pr?: number, gh: Gh = runGh): Promise<PullRequest | string> {
  const version = await gh(['--version'], cwd);
  if (version.code !== 0) return 'The GitHub CLI ("gh") is needed to comment on pull requests. Install it from https://cli.github.com and run "gh auth login".';
  const view = await gh(['pr', 'view', ...(pr ? [String(pr)] : []), '--json', 'number,title,url'], cwd);
  if (view.code !== 0) return `No pull request found${pr ? ` with number ${pr}` : ' for this branch'} (${view.stderr.trim().split('\n')[0] || 'gh pr view failed'}).`;
  try {
    const parsed = JSON.parse(view.stdout) as PullRequest;
    return { number: parsed.number, title: parsed.title, url: parsed.url };
  } catch {
    return 'Could not read "gh pr view" output.';
  }
}

/** Post `body` as Heap QA's comment on the pull request, replacing its earlier one. */
export async function postPrComment(options: { cwd: string; pr: PullRequest; body: string; gh?: Gh }): Promise<{ url?: string; updated: boolean } | string> {
  const gh = options.gh ?? runGh;
  const { cwd, pr } = options;
  const body = options.body.includes(COMMENT_MARKER) ? options.body : `${COMMENT_MARKER}\n${options.body}`;

  // `{owner}/{repo}` is filled in by gh from this checkout's remote.
  const existing = await gh(
    ['api', '--paginate', `repos/{owner}/{repo}/issues/${pr.number}/comments`, '--jq', `.[] | select(.body | contains("${COMMENT_MARKER}")) | .id`],
    cwd,
  );
  if (existing.code !== 0) return `Could not read the pull request's comments (${existing.stderr.trim().split('\n')[0]}).`;
  const id = existing.stdout.trim().split('\n').filter(Boolean).at(-1);

  if (id) {
    const patched = await gh(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '--input', '-'], cwd, JSON.stringify({ body }));
    if (patched.code !== 0) return `Could not update the comment (${patched.stderr.trim().split('\n')[0]}).`;
    try {
      return { url: (JSON.parse(patched.stdout) as { html_url?: string }).html_url, updated: true };
    } catch {
      return { updated: true };
    }
  }
  const created = await gh(['pr', 'comment', String(pr.number), '--body-file', '-'], cwd, body);
  if (created.code !== 0) return `Could not comment (${created.stderr.trim().split('\n')[0]}).`;
  return { url: created.stdout.trim() || undefined, updated: false };
}

/** The CI run this is, on GitHub Actions — where the uploaded report can be downloaded. */
export function ciRunUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
}

/**
 * A GitHub Actions workflow that runs the flows on every pull request,
 * uploads the results and comments on the pull request. The app's own
 * start-up is the part only the person knows, so it is left as clearly
 * marked lines to fill in. Never overwrites an existing file.
 */
export function writeGithubWorkflow(repoRoot: string, testFolder: string, options: { baseUrl?: string } = {}): { file: string; created: boolean } {
  const file = join(repoRoot, '.github', 'workflows', 'heapqa.yml');
  if (existsSync(file)) return { file, created: false };
  const folder = relative(repoRoot, testFolder) || '.';
  const url = options.baseUrl ?? 'http://localhost:3000';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `# Heap QA: play the flows in ${folder}/ on every pull request, upload the
# results, and keep one comment on the pull request up to date.
name: Heap QA

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  heapqa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      # ── Your app: build it and start it in the background. Edit these. ──
      - name: Start the app
        run: |
          npm ci
          npm run build --if-present
          npm start &
          npx --yes wait-on ${url}

      - name: Install Heap QA
        run: npm install -g @heaplabs/heapcode-cli

      # Exit 1 when a flow fails; the comment and the upload still happen.
      - name: Run the flows
        id: qa
        continue-on-error: true
        run: heapcode qa run --dir ${folder} --no-trace
        env:
          # Test passwords the flows type as {{secret:NAME}} — add them as
          # repository secrets, never in the flows.
          TEST_PASSWORD: \${{ secrets.TEST_PASSWORD }}

      - name: Upload the results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: heapqa-results
          path: ${folder === '.' ? '' : `${folder}/`}results/

      - name: Comment on the pull request
        if: always()
        run: heapcode qa comment --dir ${folder} --yes
        env:
          GH_TOKEN: \${{ github.token }}

      - name: Fail when a flow failed
        if: steps.qa.outcome == 'failure'
        run: exit 1
`,
  );
  return { file, created: true };
}
