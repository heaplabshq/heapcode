// @vitest-environment jsdom
/**
 * "Save to workspace" used window.prompt, which Electron does not implement —
 * it returns null and shows nothing — so in the desktop app the button did
 * nothing at all. The name is now typed into a field in the panel.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Preview } from '../src/components/Preview.js';

afterEach(cleanup);

const META = { id: 'a1', title: 'Progress Tracker', kind: 'markdown' as const, version: 2, versions: 2, updatedAt: 0 };
const ARTIFACT = { ...META, content: '# Tracker' };

function setup() {
  const onSave = vi.fn();
  // As in Electron: prompt() exists and returns nothing. It must never be used.
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
  render(<Preview artifacts={[META as never]} loadArtifact={() => Promise.resolve(ARTIFACT as never)} onSave={onSave} onSelect={() => {}} />);
  return { onSave, prompt };
}

describe('Save to workspace', () => {
  it('asks for the name in the panel, suggests one from the title, and saves that version', async () => {
    const { onSave, prompt } = setup();
    fireEvent.click(await screen.findByText('Save to workspace'));
    const field = screen.getByLabelText<HTMLInputElement>('Save as');
    expect(field.value).toBe('progress-tracker.md');
    fireEvent.change(field, { target: { value: 'docs/tracker.md' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('a1', 'docs/tracker.md', 2);
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Save as')).toBeNull();
  });

  it('closes on Escape without saving, and will not save an empty name', async () => {
    const { onSave } = setup();
    fireEvent.click(await screen.findByText('Save to workspace'));
    const field = screen.getByLabelText<HTMLInputElement>('Save as');
    fireEvent.change(field, { target: { value: '  ' } });
    expect(screen.getByText<HTMLButtonElement>('Save').disabled).toBe(true);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByLabelText('Save as')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('Open in new tab, in the desktop app', () => {
  it('hands the page to the host to open in the system browser, rather than a window it would be refused', async () => {
    const onOpenInBrowser = vi.fn();
    const open = vi.spyOn(window, 'open');
    render(
      <Preview artifacts={[META as never]} loadArtifact={() => Promise.resolve(ARTIFACT as never)} onSave={() => {}} onSelect={() => {}} onOpenInBrowser={onOpenInBrowser} />,
    );
    fireEvent.click(await screen.findByText('Open in new tab'));
    expect(open).not.toHaveBeenCalled();
    const [title, html] = onOpenInBrowser.mock.calls[0]! as [string, string];
    expect(title).toBe('Progress Tracker');
    // Still behind the sandboxed frame, as in the panel.
    expect(html).toMatch(/<iframe[^>]+sandbox="allow-scripts"/);
    expect(html).toContain('srcdoc="');
  });
});
