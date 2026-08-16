import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@heapcode/core';

/** What a renderer knows how to draw. Anything else is refused at creation. */
export const ARTIFACT_KINDS = ['html', 'markdown', 'mermaid', 'svg', 'code', 'json'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** A hard cap, so a runaway generation cannot fill the disk or wedge the browser. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface ArtifactVersion {
  content: string;
  createdAt: number;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** Optional hint for `kind: 'code'` — a highlight.js language id. */
  language?: string;
  versions: ArtifactVersion[];
}

/**
 * `create_artifact` — **not** in `agentToolDefinitions`, on purpose.
 *
 * Same reasoning as DELEGATE_TASK_TOOL (packages/host/src/agent/delegate.ts):
 * a host opts in by adding it to the tool list it sends with `agent/run`. Only
 * the web host can render an artifact, so only the web host offers it — the
 * CLI and the extension are untouched, and neither gains a tool it would have
 * to explain and could not display.
 *
 * If a second host ever grows a rendering surface, this moves to
 * @heapcode/host beside DELEGATE_TASK_TOOL. Until then, keeping it here keeps
 * the blast radius at zero.
 *
 * Permission is `read`: it writes only to heapcode's own state directory,
 * never to the workspace, so it cannot damage the user's code. Prompting for
 * every chart would make the feature unusable, and "Save to workspace" — the
 * step that *does* touch their files — is a deliberate click in the UI.
 */
export const CREATE_ARTIFACT_TOOL: ToolDefinition = {
  name: 'create_artifact',
  description:
    'Create or update a rendered artifact shown beside the conversation — a self-contained HTML page, a markdown ' +
    'report, a mermaid diagram, an SVG, or a JSON/code document. Use it when the user asks for something to LOOK ' +
    'at rather than something to put in their codebase (a dashboard, a chart, a written summary). Do NOT use it to ' +
    'write project files — use write_file for those. Pass the same id again to publish a new version of an ' +
    'existing artifact. HTML runs in a locked-down sandbox with no network access, so inline everything: no CDN ' +
    'scripts, no external stylesheets, no remote images.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id. Reuse it to publish a new version of the same artifact.' },
      title: { type: 'string', description: 'Short human-readable name.' },
      kind: { type: 'string', enum: [...ARTIFACT_KINDS], description: 'html | markdown | mermaid | svg | code | json' },
      content: { type: 'string', description: 'The full artifact source. Self-contained — nothing is fetched at render time.' },
      language: { type: 'string', description: "For kind 'code': the language, e.g. python, rust." },
    },
    required: ['title', 'kind', 'content'],
  },
  permission: 'read',
};

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * Artifacts on disk, under the project's state directory.
 *
 * Deliberately NOT in the workspace (§12 Q3): an artifact is something the
 * agent produced for the user to look at, not a project file, and writing one
 * into their repo means it lands in `git status` and eventually in a commit
 * nobody intended. "Save to workspace" exists for when they do want that, and
 * it is an explicit action.
 */
export class ArtifactStore {
  private readonly cache = new Map<string, Artifact>();
  private loaded = false;

  constructor(private readonly dir: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const files = await readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const artifact = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as Artifact;
          this.cache.set(artifact.id, artifact);
        } catch {
          // A corrupt artifact file is not worth failing the session over.
        }
      }
    } catch {
      // No directory yet — nothing has been created.
    }
  }

  async list(): Promise<Artifact[]> {
    await this.load();
    return [...this.cache.values()].sort(
      (a, b) => (b.versions.at(-1)?.createdAt ?? 0) - (a.versions.at(-1)?.createdAt ?? 0),
    );
  }

  async get(id: string): Promise<Artifact | undefined> {
    await this.load();
    return this.cache.get(id);
  }

  /** Creates, or appends a version when `id` names an existing artifact. */
  async put(input: {
    id?: string;
    title: string;
    kind: ArtifactKind;
    content: string;
    language?: string;
  }): Promise<Artifact> {
    await this.load();
    if (Buffer.byteLength(input.content, 'utf8') > MAX_ARTIFACT_BYTES) {
      throw new Error(`Artifact is over the ${Math.round(MAX_ARTIFACT_BYTES / 1024)} KB limit.`);
    }

    const id = input.id?.trim() || randomUUID();
    const existing = this.cache.get(id);
    const version: ArtifactVersion = { content: input.content, createdAt: Date.now() };

    const artifact: Artifact = existing
      ? { ...existing, title: input.title || existing.title, kind: input.kind, language: input.language, versions: [...existing.versions, version] }
      : { id, title: input.title, kind: input.kind, language: input.language, versions: [version] };

    this.cache.set(id, artifact);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${safeName(id)}.json`), JSON.stringify(artifact, null, 2), 'utf8');
    return artifact;
  }
}

/**
 * Artifact ids come from the model, so they must never shape a path.
 *
 * Separators are what actually enable traversal, so those go first. Leading
 * dots go too — not because `..foo` could escape (it cannot, once slashes are
 * gone) but because a hidden file is a surprising thing to create from a
 * model-chosen string, and `.` / `..` themselves are not valid names at all.
 */
function safeName(id: string): string {
  const flattened = id.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return (flattened || 'artifact').slice(0, 100);
}

/** Sensible file extension when an artifact is saved into the workspace. */
export function extensionFor(kind: ArtifactKind, language?: string): string {
  switch (kind) {
    case 'html':
      return 'html';
    case 'markdown':
      return 'md';
    case 'mermaid':
      return 'mmd';
    case 'svg':
      return 'svg';
    case 'json':
      return 'json';
    case 'code':
      return language ? language.toLowerCase().replace(/[^a-z0-9]/g, '') || 'txt' : 'txt';
  }
}
