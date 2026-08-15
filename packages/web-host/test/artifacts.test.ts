import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentToolDefinitions } from '@heapcode/host';
import {
  ARTIFACT_KINDS,
  ArtifactStore,
  CREATE_ARTIFACT_TOOL,
  MAX_ARTIFACT_BYTES,
  extensionFor,
  isArtifactKind,
} from '../src/artifacts.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hcart-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('create_artifact gating', () => {
  it('is NOT in the shared default tool list — the CLI and extension must not see it', () => {
    // The whole reason it lives in web-host: neither of the other two hosts
    // can render an artifact, and a tool they cannot fulfil is worse than no
    // tool. If this fails, adding it to agentToolDefinitions handed it to them.
    expect(agentToolDefinitions.map((t) => t.name)).not.toContain('create_artifact');
  });

  it('is classed read — it writes to heapcode state, never the workspace', () => {
    expect(CREATE_ARTIFACT_TOOL.permission).toBe('read');
  });

  it('advertises exactly the kinds the renderer supports', () => {
    const declared = (CREATE_ARTIFACT_TOOL.parameters as { properties: { kind: { enum: string[] } } }).properties.kind
      .enum;
    expect([...declared].sort()).toEqual([...ARTIFACT_KINDS].sort());
  });

  it('tells the model the sandbox has no network, so it inlines assets', () => {
    expect(CREATE_ARTIFACT_TOOL.description).toMatch(/no network|inline/i);
  });
});

describe('isArtifactKind', () => {
  it('accepts known kinds and rejects anything else', () => {
    expect(isArtifactKind('html')).toBe(true);
    expect(isArtifactKind('mermaid')).toBe(true);
    expect(isArtifactKind('exe')).toBe(false);
    expect(isArtifactKind(undefined)).toBe(false);
  });
});

describe('ArtifactStore', () => {
  it('creates an artifact and reads it back', async () => {
    const store = new ArtifactStore(dir);
    const a = await store.put({ title: 'Chart', kind: 'html', content: '<p>1</p>' });
    expect(a.versions).toHaveLength(1);
    expect((await store.get(a.id))?.title).toBe('Chart');
  });

  it('appends a version when the same id is reused, keeping the old one', async () => {
    const store = new ArtifactStore(dir);
    const first = await store.put({ id: 'dash', title: 'Dash', kind: 'html', content: '<p>v1</p>' });
    const second = await store.put({ id: 'dash', title: 'Dash', kind: 'html', content: '<p>v2</p>' });

    expect(first.id).toBe('dash');
    expect(second.versions).toHaveLength(2);
    expect(second.versions[0]!.content).toBe('<p>v1</p>');
    expect(second.versions[1]!.content).toBe('<p>v2</p>');
  });

  it('persists across instances', async () => {
    await new ArtifactStore(dir).put({ id: 'keep', title: 'Keep', kind: 'markdown', content: '# hi' });
    const reloaded = await new ArtifactStore(dir).get('keep');
    expect(reloaded?.versions[0]!.content).toBe('# hi');
  });

  it('refuses content over the size cap', async () => {
    const store = new ArtifactStore(dir);
    await expect(
      store.put({ title: 'Huge', kind: 'code', content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) }),
    ).rejects.toThrow(/limit/);
  });

  it('never lets a model-supplied id shape a path', async () => {
    const store = new ArtifactStore(dir);
    // The id comes from the model, so it is untrusted input to a filename.
    await store.put({ id: '../../escape', title: 'Sneaky', kind: 'code', content: 'x' });
    const files = await readdir(dir);
    // What matters is that it landed HERE, flat, under one ordinary name —
    // separators are what enable traversal, and there are none.
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('\\');
    expect(files[0]).not.toMatch(/^\./); // not hidden, and never bare `.`/`..`
  });

  it('survives an id made entirely of separators', async () => {
    const store = new ArtifactStore(dir);
    await store.put({ id: '../..', title: 'Edge', kind: 'code', content: 'x' });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/^\./);
  });

  it('lists most-recently-updated first', async () => {
    const store = new ArtifactStore(dir);
    await store.put({ id: 'old', title: 'Old', kind: 'code', content: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    await store.put({ id: 'new', title: 'New', kind: 'code', content: 'b' });
    expect((await store.list()).map((a) => a.id)).toEqual(['new', 'old']);
  });
});

describe('extensionFor', () => {
  it('maps kinds to sensible extensions', () => {
    expect(extensionFor('html')).toBe('html');
    expect(extensionFor('markdown')).toBe('md');
    expect(extensionFor('mermaid')).toBe('mmd');
    expect(extensionFor('code', 'Python')).toBe('python');
    expect(extensionFor('code')).toBe('txt');
  });
});
