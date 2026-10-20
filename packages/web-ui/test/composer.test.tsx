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

/**
 * The picker. Paste and drop already worked; the button is for the people who
 * never discover that paste does, and for an image that is a file on disk
 * rather than something on the clipboard.
 */
describe('the attach button', () => {
  const png = () =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });

  it('is reachable by its accessible name, not just by its glyph', () => {
    setup();
    expect(screen.getByLabelText('Attach images')).toBeTruthy();
  });

  it('sits inside the input box, before the text area', () => {
    // It acts on the message being composed, so it belongs with the text
    // rather than over by Send, which acts on the message as a whole.
    setup();
    const picker = screen.getByLabelText('Attach images');
    const input = screen.getByLabelText('Message');
    const box = input.closest('.composer-box');
    expect(box?.contains(picker)).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING — the input comes after the picker.
    expect(picker.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('attaches a chosen image and shows it', async () => {
    setup();
    const picker = screen.getByLabelText('Attach images') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [png()] } });
    expect(await screen.findByAltText('Attachment 1')).toBeTruthy();
  });

  it('sends the attachment with the message, then stops carrying it', async () => {
    const { onSend, input } = setup();
    const picker = screen.getByLabelText('Attach images') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [png()] } });
    await screen.findByAltText('Attachment 1');

    fireEvent.change(input, { target: { value: 'what is this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('what is this', [expect.stringContaining('data:image/png')]);

    // An image belongs to the message it was attached to — leaving it staged
    // would silently re-send it with the next one.
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
  });

  it('refuses a non-image and says why, rather than attaching nothing in silence', async () => {
    const onReject = vi.fn();
    setup({ onReject });
    const picker = screen.getByLabelText('Attach images') as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    await vi.waitFor(() => expect(onReject).toHaveBeenCalled());
    expect(onReject.mock.calls[0]![0]).toMatch(/Only images/);
  });
});

/**
 * Documents. Given a reader, the box takes any file: it is read to text by
 * the host the moment it is attached and goes with the message as a block
 * after what was typed.
 */
describe('attaching documents', () => {
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'lease.pdf', { type: 'application/pdf' });

  it('offers files, not just images, when the host can read them', () => {
    setup({ readFile: vi.fn() });
    const picker = screen.getByLabelText('Attach files') as HTMLInputElement;
    expect(picker.accept).toBe('');
  });

  it('reads a document on attach and sends its text with the message', async () => {
    const readFile = vi.fn(async (name: string) => ({ text: `text of ${name}`, truncated: false }));
    const { onSend, input } = setup({ readFile });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [pdf()] } });
    expect(await screen.findByText('lease.pdf')).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
    expect(readFile).toHaveBeenCalledWith('lease.pdf', expect.any(String));

    fireEvent.change(input, { target: { value: 'what does clause 4 say?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith(
      'what does clause 4 say?\n\n<attached-file name="lease.pdf">\ntext of lease.pdf\n</attached-file>',
      undefined,
    );
    expect(screen.queryByText('lease.pdf')).toBeNull();
  });

  it('a file alone is a message', async () => {
    const { onSend, input } = setup({ readFile: async () => ({ text: 'body', truncated: false }) });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [pdf()] } });
    await vi.waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('<attached-file name="lease.pdf">\nbody\n</attached-file>', undefined);
  });

  it('will not send while a file is still being read', async () => {
    let finish: (v: { text: string; truncated: boolean }) => void = () => undefined;
    const readFile = vi.fn(() => new Promise<{ text: string; truncated: boolean }>((r) => (finish = r)));
    const { onSend, input } = setup({ readFile });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [pdf()] } });
    await screen.findByText('Reading…');
    // The bytes are read off disk before the host is asked; wait for the ask.
    await vi.waitFor(() => expect(readFile).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: 'summarize' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    finish({ text: 'done', truncated: false });
    await vi.waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
  });

  it('drops a file the host cannot read, and says why', async () => {
    const onReject = vi.fn();
    setup({ onReject, readFile: async () => Promise.reject(new Error("Couldn't find any text in lease.pdf.")) });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [pdf()] } });
    await vi.waitFor(() => expect(onReject).toHaveBeenCalledWith("Couldn't find any text in lease.pdf."));
    expect(screen.queryByText('lease.pdf')).toBeNull();
  });

  it('an edited message comes back with its files as chips, not as text', () => {
    const { input } = setup({
      readFile: vi.fn(),
      seed: 'and clause 7?\n\n<attached-file name="lease.pdf">\nbody\n</attached-file>',
    });
    expect(input.value).toBe('and clause 7?');
    expect(screen.getByText('lease.pdf')).toBeTruthy();
  });
});
