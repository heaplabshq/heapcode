import { describe, expect, it } from 'vitest';
import { SANDBOX, buildFrameDocument } from '../src/artifactFrame.js';

/**
 * The artifact sandbox.
 *
 * This is the one place in the app where untrusted, model-authored HTML runs
 * as script. The properties below are what stop it reaching the page that
 * holds the session cookie and the WebSocket that runs shell commands — so
 * they are asserted rather than assumed. A change that breaks any of these
 * should fail loudly here.
 */

describe('sandbox attribute', () => {
  it('allows scripts', () => {
    expect(SANDBOX).toContain('allow-scripts');
  });

  it('NEVER allows same-origin — with allow-scripts that pair defeats the sandbox', () => {
    // allow-scripts + allow-same-origin lets the frame remove its own sandbox
    // attribute and escape. This assertion is the whole point of the file.
    expect(SANDBOX).not.toContain('allow-same-origin');
  });

  it('grants nothing else that could reach the parent or navigate it', () => {
    for (const token of [
      'allow-top-navigation',
      'allow-popups',
      'allow-modals',
      'allow-forms',
      'allow-pointer-lock',
      'allow-downloads',
      'allow-presentation',
    ]) {
      expect(SANDBOX, token).not.toContain(token);
    }
  });
});

describe('content security policy', () => {
  const doc = buildFrameDocument({ kind: 'html', content: '<p>hi</p>' });

  it('is present in the document, since srcdoc cannot carry headers', () => {
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
  });

  it('denies everything by default', () => {
    expect(doc).toContain("default-src 'none'");
  });

  it('blocks all network egress — no CDN, no remote images, no fetch home', () => {
    expect(doc).toContain("connect-src 'none'");
    // Images and fonts are data: only; neither allows an outbound request.
    expect(doc).toContain('img-src data:');
    expect(doc).toContain('font-src data:');
    // No https: or * anywhere in the policy.
    const csp = /content="([^"]+)"/.exec(doc.split('Content-Security-Policy')[1] ?? '')?.[1] ?? '';
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain('*');
  });

  it('blocks form submission and base-tag hijacking', () => {
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
  });

  it('blocks nested frames and plugins', () => {
    expect(doc).toContain("frame-src 'none'");
    expect(doc).toContain("object-src 'none'");
  });
});

describe('body rendering', () => {
  it('inlines html verbatim — that is the feature, and why the sandbox exists', () => {
    const doc = buildFrameDocument({ kind: 'html', content: '<h1>Dashboard</h1><script>x()</script>' });
    expect(doc).toContain('<h1>Dashboard</h1>');
  });

  it('escapes code and json rather than executing them', () => {
    const doc = buildFrameDocument({ kind: 'code', content: '<script>alert(1)</script>' });
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).not.toContain('<script>alert(1)</script>');
  });

  it('pretty-prints json, and tolerates json that does not parse', () => {
    expect(buildFrameDocument({ kind: 'json', content: '{"a":1}' })).toContain('&quot;a&quot;: 1');
    expect(buildFrameDocument({ kind: 'json', content: 'not json' })).toContain('not json');
  });

  it('falls back to mermaid source when no SVG was rendered', () => {
    const doc = buildFrameDocument({ kind: 'mermaid', content: 'graph TD; A-->B;' });
    expect(doc).toContain('graph TD; A--&gt;B;');
  });

  it('injects rendered mermaid SVG when one is supplied', () => {
    const doc = buildFrameDocument({ kind: 'mermaid', content: 'graph TD; A-->B;', mermaidSvg: '<svg id="d"></svg>' });
    expect(doc).toContain('<svg id="d"></svg>');
  });

  it('treats an unknown kind as source rather than guessing', () => {
    const doc = buildFrameDocument({ kind: 'something-new', content: '<b>x</b>' });
    expect(doc).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
