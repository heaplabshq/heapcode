import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, ciRunUrl, findPullRequest, postPrComment, writeGithubWorkflow, type Gh } from '../src/github.js';

/** A gh that answers from a script and remembers what it was asked. */
function fakeGh(answers: Record<string, { stdout?: string; stderr?: string; code?: number }>): { gh: Gh; calls: { args: string[]; stdin?: string }[] } {
  const calls: { args: string[]; stdin?: string }[] = [];
  const gh: Gh = async (args, _cwd, stdin) => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
    const a = key ? answers[key]! : { code: 1, stderr: 'unexpected' };
    return { stdout: a.stdout ?? '', stderr: a.stderr ?? '', code: a.code ?? 0 };
  };
  return { gh, calls };
}

const pr = { number: 12, title: 'Add checkout', url: 'https://github.com/o/r/pull/12' };

describe('pull request comments', () => {
  it('finds the branch pull request, or says why not', async () => {
    const ok = fakeGh({ '--version': {}, 'pr view': { stdout: JSON.stringify(pr) } });
    expect(await findPullRequest('/repo', undefined, ok.gh)).toEqual(pr);
    const noGh = fakeGh({ '--version': { code: 127 } });
    expect(await findPullRequest('/repo', undefined, noGh.gh)).toMatch(/GitHub CLI \("gh"\) is needed/);
    const none = fakeGh({ '--version': {}, 'pr view': { code: 1, stderr: 'no pull requests found for branch "x"' } });
    expect(await findPullRequest('/repo', 7, none.gh)).toBe('No pull request found with number 7 (no pull requests found for branch "x").');
  });

  it('creates the comment, with its marker, when there is none of its own', async () => {
    const f = fakeGh({ 'api --paginate': { stdout: '' }, 'pr comment': { stdout: 'https://github.com/o/r/pull/12#issuecomment-1\n' } });
    const r = await postPrComment({ cwd: '/repo', pr, body: '### ✓ all passed', gh: f.gh });
    expect(r).toEqual({ url: 'https://github.com/o/r/pull/12#issuecomment-1', updated: false });
    expect(f.calls[0]!.args).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/issues/12/comments', '--jq', `.[] | select(.body | contains("${COMMENT_MARKER}")) | .id`]);
    expect(f.calls[1]).toEqual({ args: ['pr', 'comment', '12', '--body-file', '-'], stdin: `${COMMENT_MARKER}\n### ✓ all passed` });
  });

  it('updates its own earlier comment instead of adding another', async () => {
    const f = fakeGh({ 'api --paginate': { stdout: '111\n222\n' }, 'api -X PATCH': { stdout: JSON.stringify({ html_url: 'https://x/c/222' }) } });
    const r = await postPrComment({ cwd: '/repo', pr, body: `${COMMENT_MARKER}\nnew`, gh: f.gh });
    expect(r).toEqual({ url: 'https://x/c/222', updated: true });
    expect(f.calls[1]!.args).toEqual(['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/comments/222', '--input', '-']);
    expect(JSON.parse(f.calls[1]!.stdin!)).toEqual({ body: `${COMMENT_MARKER}\nnew` });
    expect(f.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'comment')).toBe(false);
  });

  it('links the CI run when there is one', () => {
    expect(ciRunUrl({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' })).toBe('https://github.com/o/r/actions/runs/9');
    expect(ciRunUrl({})).toBeUndefined();
  });
});

describe('writeGithubWorkflow', () => {
  it('writes a workflow for the test folder, once', () => {
    const repo = mkdtempSync(join(tmpdir(), 'heapqa-gh-'));
    mkdirSync(join(repo, 'heapqa'));
    const first = writeGithubWorkflow(repo, join(repo, 'heapqa'), { baseUrl: 'http://localhost:5173' });
    expect(first.created).toBe(true);
    const yaml = readFileSync(first.file, 'utf8');
    expect(yaml).toContain('run: heapcode qa run --dir heapqa --no-trace');
    expect(yaml).toContain('run: heapcode qa comment --dir heapqa --yes');
    expect(yaml).toContain('npx --yes wait-on http://localhost:5173');
    expect(yaml).toContain('path: heapqa/results/');
    expect(yaml).toContain('TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}');
    expect(yaml).toContain('pull-requests: write');
    writeFileSync(first.file, 'mine');
    expect(writeGithubWorkflow(repo, join(repo, 'heapqa')).created).toBe(false);
    expect(readFileSync(first.file, 'utf8')).toBe('mine');
  });
});
