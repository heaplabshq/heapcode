// @vitest-environment jsdom
/**
 * The model type-ahead.
 *
 * Deliberately not a `<select>`: the fetched list is the answer nearly every
 * time, but a proxy that serves models it will not enumerate is common enough
 * that a closed dropdown would make those profiles uneditable. So both halves
 * have to work — and the failure path most of all, since an endpoint you cannot
 * reach is exactly when you are trying to fix the profile.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelInput } from '../src/components/ModelInput.js';

afterEach(cleanup);

const MODELS = ['llama3:8b', 'llama3:70b', 'nomic-embed-text'];

/**
 * Controlled, like the real caller. A mock `onChange` that never feeds the new
 * value back would leave the field permanently empty, and the filter — which
 * reads `value` — would look like it did nothing.
 */
function setup(over: { value?: string; listModels?: () => Promise<string[]> } = {}) {
  const onChange = vi.fn();
  const listModels = over.listModels ?? (() => Promise.resolve(MODELS));

  function Harness(): JSX.Element {
    const [value, setValue] = useState(over.value ?? '');
    return (
      <ModelInput
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        aria-label="Embeddings model"
        listModels={listModels}
      />
    );
  }

  render(<Harness />);
  return { onChange, input: screen.getByLabelText('Embeddings model') };
}

describe('ModelInput', () => {
  it('fetches nothing until the field is focused', async () => {
    // A profile editor has seven role fields; fetching on mount would be seven
    // provider round-trips just for opening it.
    const listModels = vi.fn(() => Promise.resolve(MODELS));
    const { input } = setup({ listModels });
    expect(listModels).not.toHaveBeenCalled();

    fireEvent.focus(input);
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    // And not again on every subsequent focus.
    fireEvent.blur(input);
    fireEvent.focus(input);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('narrows the list as you type', async () => {
    const { input } = setup();
    fireEvent.focus(input);
    await screen.findByText('nomic-embed-text');

    fireEvent.change(input, { target: { value: 'llama' } });
    await waitFor(() => expect(screen.queryByText('nomic-embed-text')).toBeNull());
    expect(screen.getByText('llama3:8b')).toBeTruthy();
    expect(screen.getByText('llama3:70b')).toBeTruthy();
  });

  it('picks with the mouse', async () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    const option = await screen.findByText('llama3:70b');
    // mousedown, not click — blur would tear the list down first.
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenLastCalledWith('llama3:70b');
  });

  it('picks with the keyboard', async () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    await screen.findByText('llama3:8b');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('llama3:70b');
  });

  it('still accepts an id the endpoint never advertised', async () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    await screen.findByText('llama3:8b');
    fireEvent.change(input, { target: { value: 'some/private-model:v2' } });
    // No match, no list, and the typed value stands.
    expect(onChange).toHaveBeenLastCalledWith('some/private-model:v2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('degrades to a plain text box when the endpoint cannot be reached', async () => {
    const { input, onChange } = setup({ listModels: () => Promise.reject(new Error('ECONNREFUSED')) });
    fireEvent.focus(input);
    // Failing to *list* models is no reason to stop someone *naming* one.
    expect(await screen.findByText(/Could not list models/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'llama3' } });
    expect(onChange).toHaveBeenLastCalledWith('llama3');
  });

  it('lets Escape close the list without closing the dialog around it', async () => {
    const onDialogEscape = vi.fn();
    document.addEventListener('keydown', onDialogEscape);
    const { input } = setup();
    fireEvent.focus(input);
    await screen.findByText('llama3:8b');

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    document.removeEventListener('keydown', onDialogEscape);
  });
});
