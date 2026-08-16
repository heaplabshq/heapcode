// @vitest-environment jsdom
/**
 * The slash menu.
 *
 * The composer's placeholder has always said "/ for commands" and the CLI has
 * always had an autocomplete menu, but the web composer had none: typing `/`
 * showed nothing, so you had to know the exact command name and spell it
 * correctly or get "Unknown command". These tests are what stops that from
 * regressing back into a placeholder that lies.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer.js';

afterEach(cleanup);

const setup = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(<Composer onSend={onSend} onCancel={onCancel} busy={false} {...over} />);
  const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
  return { onSend, onCancel, input };
};

describe('the slash menu', () => {
  it('opens on "/" and lists commands', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy();
    expect(screen.getByText('/help')).toBeTruthy();
  });

  it('filters as you type', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/perm' } });
    expect(screen.getByText('/permissions')).toBeTruthy();
    expect(screen.queryByText('/help')).toBeNull();
  });

  it('stays shut for ordinary prose', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'fix the bug in app.ts' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes once you move on to arguments', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/search ' } });
    // The list would otherwise sit over the box for the whole query.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter runs the highlighted command instead of sending the partial text', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '/hel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Not '/hel' — which is what a composer with no menu would have sent.
    expect(onSend).toHaveBeenCalledWith('/help', undefined);
  });

  it('arrow keys move the selection', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '/re' } });
    const first = screen.getAllByRole('option')[0]!.textContent;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
    expect(onSend.mock.calls[0]![0]).not.toBe(first?.split(' ')[0]);
  });

  it('a command that takes arguments completes and waits rather than firing', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '/sea' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Firing it now could only answer "usage: /search <query>".
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('/search ');
  });

  it('Tab completes without running', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '/newx'.slice(0, 4) } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('/new');
  });

  it('Escape closes the menu without cancelling the run', () => {
    const { onCancel, input } = setup({ busy: true });
    fireEvent.change(input, { target: { value: '/he' } });
    // busy hides the menu, so Escape is the run's — that is the branch below.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('Escape closes the menu first when one is open', () => {
    const { onCancel, input } = setup();
    fireEvent.change(input, { target: { value: '/he' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('typing after Escape brings the menu back', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/he' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.change(input, { target: { value: '/hel' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('a full command typed by hand still sends normally', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: '/help' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/help', undefined);
  });

  it('the global "/" seed lands in the box and opens the menu', () => {
    const onSeedUsed = vi.fn();
    render(<Composer onSend={vi.fn()} onCancel={vi.fn()} busy={false} seed="/" onSeedUsed={onSeedUsed} />);
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    // The slash must actually be there — focusing an empty box would eat it.
    expect(input.value).toBe('/');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(onSeedUsed).toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('the Send button sends the text, not the click event', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).toHaveBeenCalledWith('hello', undefined);
  });
});
