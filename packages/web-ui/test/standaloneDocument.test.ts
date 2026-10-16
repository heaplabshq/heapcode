import { describe, expect, it } from 'vitest';
import { SANDBOX, standaloneDocument } from '../src/artifactFrame.js';

describe('standaloneDocument', () => {
  it('keeps the artifact in its sandbox, with its markup escaped into the frame — never into the page', () => {
    const html = standaloneDocument('A "quoted" <title>', '<script>alert(1)</script><p title="x">hi</p>');
    expect(html).toContain(`sandbox="${SANDBOX}"`);
    expect(html).toContain('<title>A &quot;quoted&quot; &lt;title&gt;</title>');
    // The only <script> is inside the escaped srcdoc, so it runs in the frame alone.
    expect(html).not.toContain('<script>');
    expect(html).toContain('srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;&lt;p title=&quot;x&quot;&gt;hi&lt;/p&gt;"');
  });
});
