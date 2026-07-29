import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYWORD_INDEX_FILE } from '@heapcode/core';
import { WorkspaceKeywordIndex } from '../src/rag/keywordIndex.js';
import { collectRepoContext } from '../src/completionProvider.js';
import {
  Uri,
  __fireDidSave,
  __resetConfig,
  InlineCompletionTriggerKind,
  __setFindFilesWalk,
  __setWorkspaceRoot,
} from './vscodeStub.js';

/**
 * Decision 1 of the RAG migration (docs/phase3-rag-design.md open question 1):
 * ghost text's typing trigger keeps retrieving in this process, from its own
 * vector-free index, rather than paying a socket round-trip on a keystroke
 * deadline or mirroring the server's vector store.
 *
 * What these tests hold onto is the property that makes that decision worth
 * anything — a completion is served with no call to the semantic index at
 * all — and decision 2's freshness rule, that the keyword index updates from
 * the same editor save event the semantic index already used.
 */

let root: string;
let log: { appendLine: (line: string) => void; lines: string[] };
let keywords: WorkspaceKeywordIndex;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-vsc-keyword-'));
  __setWorkspaceRoot(root);
  __setFindFilesWalk(true);
  const lines: string[] = [];
  log = { lines, appendLine: (line: string) => lines.push(line) };
});

afterEach(async () => {
  keywords?.dispose();
  __setFindFilesWalk(false);
  __setWorkspaceRoot(undefined);
  __resetConfig();
  await rm(root, { recursive: true, force: true });
});

function makeIndex(): WorkspaceKeywordIndex {
  keywords = new WorkspaceKeywordIndex(
    Uri.file(join(root, '.state')),
    log as unknown as Parameters<typeof WorkspaceKeywordIndex.prototype.constructor>[1],
  );
  return keywords;
}

async function writeCorpus(): Promise<void> {
  await writeFile(join(root, 'billing.ts'), 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n');
  await writeFile(join(root, 'auth.ts'), 'export function authenticateUser(token: string) {\n  return verifySession(token);\n}\n');
}

describe('WorkspaceKeywordIndex', () => {
  it('builds from the workspace and searches, with no semantic index in play', async () => {
    await writeCorpus();
    const index = makeIndex();
    await index.init();

    await index.buildIndex();

    expect(index.inner.fileCount).toBe(2);
    expect(index.inner.search('chargeCard gateway', 1)[0]!.path).toBe('billing.ts');
  });

  it('updates on onDidSaveTextDocument — the same trigger the semantic index uses', async () => {
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();
    expect(index.inner.search('refundPayment', 1)).toEqual([]);

    await writeFile(join(root, 'billing.ts'), 'export function refundPayment(id: string) {\n  return gateway.refund(id);\n}\n');
    __fireDidSave(Uri.file(join(root, 'billing.ts')));
    await vi.waitFor(() => expect(index.inner.search('refundPayment', 1)).toHaveLength(1));

    expect(index.inner.search('refundPayment', 1)[0]!.path).toBe('billing.ts');
  });

  it('ignores saves of files it would never index', async () => {
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();
    const before = index.inner.chunkCount;

    await writeFile(join(root, 'notes.bin'), 'whatever');
    __fireDidSave(Uri.file(join(root, 'notes.bin')));
    await new Promise((r) => setTimeout(r, 20));

    expect(index.inner.chunkCount).toBe(before);
  });

  it('persists to its own file, separate from the semantic index', async () => {
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();

    const reloaded = new WorkspaceKeywordIndex(
      Uri.file(join(root, '.state')),
      log as unknown as never,
    );
    await reloaded.init();

    expect(reloaded.inner.chunkCount).toBe(index.inner.chunkCount);
    expect(KEYWORD_INDEX_FILE).toBe('keyword-index.json');
    reloaded.dispose();
  });
});

describe('ghost text retrieval', () => {
  /** A document just complete enough for collectRepoContext. */
  function doc(name: string) {
    return { uri: Uri.file(join(root, name)), languageId: 'typescript' } as never;
  }

  /** Stands in for ServerLink — the only thing collectRepoContext asks of it. */
  function fakeLink() {
    return {
      ragQuery: vi.fn().mockResolvedValue({
        formatted: '',
        hits: [{ path: 'auth.ts', startLine: 1, endLine: 3, text: 'export function authenticateUser() {}', score: 1 }],
      }),
    };
  }

  it('serves a typing-triggered completion from the keyword index, never the semantic one', async () => {
    // The regression this guards is the whole reason decision 1 exists: if
    // repo context came from `rag` on this path, it would be a socket call
    // once the vector store lives in the server.
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();
    const link = fakeLink();

    const context = await collectRepoContext(
      link,
      index.inner,
      doc('new.ts'),
      'chargeCard(',
      InlineCompletionTriggerKind.Automatic,
    );

    expect(link.ragQuery).not.toHaveBeenCalled();
    expect(context).toContain('billing.ts');
  });

  it('still uses the semantic index on a manual trigger, where the user is explicitly waiting', async () => {
    // The control for the test above: proves it reaches the branch at all.
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();
    const link = fakeLink();

    const context = await collectRepoContext(
      link,
      index.inner,
      doc('new.ts'),
      'chargeCard(',
      InlineCompletionTriggerKind.Invoke,
    );

    expect(link.ragQuery).toHaveBeenCalledWith('chargeCard(', 4);
    expect(context).toContain('auth.ts');
  });

  it('serves typing triggers even when the semantic index has nothing', async () => {
    // No embeddings model configured is an ordinary state, and it used to
    // disable ghost text's repo context entirely (the old `ready` gate).
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();
    const link = { ragQuery: vi.fn().mockResolvedValue({ formatted: '', hits: [] }) };

    const context = await collectRepoContext(
      link,
      index.inner,
      doc('new.ts'),
      'chargeCard(',
      InlineCompletionTriggerKind.Automatic,
    );

    expect(context).toContain('billing.ts');
  });

  it('never quotes the file being edited back at itself', async () => {
    await writeCorpus();
    const index = makeIndex();
    await index.init();
    await index.buildIndex();

    const context = await collectRepoContext(
      fakeLink(),
      index.inner,
      doc('billing.ts'),
      'chargeCard(',
      InlineCompletionTriggerKind.Automatic,
    );

    expect(context).not.toContain('billing.ts');
  });
});
