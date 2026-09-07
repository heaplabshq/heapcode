import { useEffect, useMemo, useState } from 'react';
import { Empty } from './Empty.js';
import type { UiArtifactMeta, UiArtifactResult } from '@heapcode/web-host/protocol';
import { SANDBOX, buildFrameDocument, mountStandalone } from '../artifactFrame.js';
import { renderMarkdown } from '../markdown.js';

export interface PreviewProps {
  artifacts: UiArtifactMeta[];
  loadArtifact(id: string, version?: number): Promise<UiArtifactResult>;
  onSave(id: string, path: string, version?: number): void;
  /** Set when a chip or the panel asked for a specific artifact. */
  selectedId?: string;
  onSelect(id: string): void;
}

export function Preview(props: PreviewProps): JSX.Element {
  const selected = props.selectedId ?? props.artifacts[0]?.id;
  const [artifact, setArtifact] = useState<UiArtifactResult>();
  const [version, setVersion] = useState<number>();
  const [mermaidSvg, setMermaidSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState(false);

  const { loadArtifact } = props;
  useEffect(() => {
    if (!selected) return setArtifact(undefined);
    let live = true;
    setError(undefined);
    void loadArtifact(selected, version)
      .then((a) => live && setArtifact(a))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selected, version, loadArtifact]);

  // Selecting a different artifact must not carry the previous one's version.
  useEffect(() => setVersion(undefined), [selected]);

  // Mermaid is loaded on demand: it is by far the heaviest thing the UI can
  // pull in, and most sessions never produce a diagram. A dynamic import keeps
  // it out of the main bundle entirely.
  useEffect(() => {
    setMermaidSvg(undefined);
    if (artifact?.kind !== 'mermaid') return;
    let live = true;
    void renderMermaid(artifact.id, artifact.content)
      .then((svg) => live && setMermaidSvg(svg))
      .catch(() => {
        /* falls back to showing the source */
      });
    return () => {
      live = false;
    };
  }, [artifact]);

  const srcDoc = useMemo(() => {
    if (!artifact) return '';
    return buildFrameDocument({
      kind: artifact.kind,
      // Markdown is rendered (and sanitized) out here, then handed to the
      // frame as HTML — one markdown pipeline for the whole app.
      content: artifact.kind === 'markdown' ? renderMarkdown(artifact.content) : artifact.content,
      language: artifact.language,
      mermaidSvg,
    });
  }, [artifact, mermaidSvg]);

  if (props.artifacts.length === 0) {
    return (
      <Empty>
        No artifacts yet. Ask for something to look at — a chart, a dashboard, a written report — and it renders
        here.
      </Empty>
    );
  }

  return (
    <div className="preview">
      <div className="preview-bar">
        <select className="select" value={selected} onChange={(e) => props.onSelect(e.target.value)} aria-label="Artifact">
          {props.artifacts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>

        {artifact && artifact.versions > 1 && (
          <select
            className="select"
            value={artifact.version}
            onChange={(e) => setVersion(Number(e.target.value))}
            aria-label="Version"
          >
            {Array.from({ length: artifact.versions }, (_, i) => i + 1).map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        )}

        {artifact && (
          <div className="preview-bar-actions">
            {/* A panel is about half a window wide at best. Anything laid out
                for a screen — a dashboard, a wide table — needs a screen. */}
            <button
              className="btn"
              onClick={() => {
                // Opened synchronously in the handler, or the popup blocker
                // takes it. `noopener` is not passed because the handle is
                // what we write into; the reference back is cut instead.
                const win = window.open('', '_blank');
                if (!win) return setBlocked(true);
                win.opener = null;
                setBlocked(false);
                mountStandalone(win, artifact.title, srcDoc);
              }}
            >
              Open in new tab
            </button>
            <button
              className="btn"
              onClick={() => {
                const suggested = `${slug(artifact.title)}.${extFor(artifact.kind, artifact.language)}`;
                const path = window.prompt('Save to workspace as:', suggested);
                if (path) props.onSave(artifact.id, path, artifact.version);
              }}
            >
              Save to workspace
            </button>
          </div>
        )}
      </div>

      {error && <p className="hint">{error}</p>}
      {blocked && <p className="hint">Your browser blocked the new tab — allow pop-ups for this page to open it.</p>}

      {artifact && (
        <iframe
          className="preview-frame"
          title={artifact.title}
          // The whole security model of artifacts (see artifactFrame.ts).
          // `allow-same-origin` must NEVER be added here.
          sandbox={SANDBOX}
          srcDoc={srcDoc}
        />
      )}
    </div>
  );
}

/**
 * Renders mermaid to SVG in the parent, then injects the result.
 *
 * Mermaid needs real DOM measurement, which it cannot do inside a sandboxed
 * frame it has no script access to — so the rendering happens here and only
 * the resulting SVG crosses into the frame. That SVG still goes through the
 * same CSP, so a diagram cannot smuggle in a network request.
 */
async function renderMermaid(id: string, source: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const { svg } = await mermaid.render(`m-${id.replace(/[^a-zA-Z0-9_-]/g, '')}-${Date.now()}`, source);
  return svg;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
}

function extFor(kind: string, language?: string): string {
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
    default:
      return language?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'txt';
  }
}
