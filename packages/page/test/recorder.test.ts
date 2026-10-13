// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Recorder, cssPath, describeTarget, isStableId } from '../src/recorder.js';
import type { RecordedEvent } from '../src/recording.js';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

let recorder: Recorder | undefined;
afterEach(() => recorder?.stop());

function record(html: string, toolbar = false): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  recorder = new Recorder(page(html), (e) => {
    events.push(e);
  });
  recorder.start({ toolbar });
  return events;
}

const $ = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;

function typeInto(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('describeTarget', () => {
  it('collects every way to find a button', () => {
    page('<main><button id="save" data-testid="save-btn" class="primary">Save</button></main>');
    const t = describeTarget($('#save'), false);
    expect(t.locator).toEqual({ testId: 'save-btn', role: 'button', name: 'Save', text: 'Save', css: '#save' });
    expect(t.describe).toBe('the "Save" button');
  });

  it('finds fields by label and placeholder, and names their value', () => {
    page('<form><label for="e">Email address</label><input id="e" placeholder="you@x.test"></form>');
    const t = describeTarget($('#e'), false);
    expect(t.locator).toMatchObject({ role: 'textbox', name: 'Email address', label: 'Email address', placeholder: 'you@x.test' });
    expect(t.field).toBe('Email address');
    expect(t.describe).toBe('the Email address field');
  });

  it('skips generated ids and numbers duplicates', () => {
    page('<ul><li><button id=":r12:">Add</button></li><li><button id="a-123456">Add</button></li></ul>');
    expect(isStableId(':r12:')).toBe(false);
    expect(isStableId('a-123456')).toBe(false);
    expect(isStableId('checkout')).toBe(true);
    const second = document.querySelectorAll('button')[1]!;
    expect(cssPath(second)).toBe('ul > li:nth-of-type(2) > button');
    // The position path tells them apart, so no `nth` is needed…
    expect(describeTarget(second, false).locator).not.toHaveProperty('nth');
  });

  it('falls back to nth when nothing else tells duplicates apart', () => {
    // …but five levels deep, the short path no longer reaches anything unique.
    const deep = (n: number): string => `${'<div>'.repeat(6)}<button id=":r${n}:">Add</button>${'</div>'.repeat(6)}`;
    page(deep(1) + deep(2));
    const second = document.querySelectorAll('button')[1]!;
    expect(describeTarget(second, false).locator).toMatchObject({ role: 'button', name: 'Add', nth: 1 });
  });

  it('fingerprints the element when asked', () => {
    page('<button data-testid="go">Go</button>');
    expect(describeTarget($('button')).fingerprint).toMatchObject({ tag: 'button', testId: 'go', name: 'Go' });
  });
});

describe('Recorder', () => {
  it('records the button, not the icon inside it', () => {
    const events = record('<button>Save <span id="icon">*</span></button>');
    $('#icon').click();
    expect(events).toMatchObject([{ kind: 'click', target: { locator: { role: 'button', name: 'Save *' } } }]);
  });

  it('sends typing once, as the final value, before the next click', () => {
    const events = record('<label for="q">Search</label><input id="q"><button>Go</button>');
    const input = $('#q') as HTMLInputElement;
    input.click();
    typeInto(input, 'l');
    typeInto(input, 'laptop');
    $('button').click();
    expect(events.map((e) => e.kind)).toEqual(['fill', 'click']);
    expect(events[0]).toMatchObject({ kind: 'fill', value: 'laptop', sensitive: false, target: { field: 'Search' } });
  });

  it('flushes on Enter and then records the key, without sending the value twice', () => {
    const events = record('<input aria-label="Search">');
    const input = $('input') as HTMLInputElement;
    typeInto(input, 'shoes');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events.map((e) => e.kind)).toEqual(['fill', 'press']);
  });

  it('marks password fields sensitive', () => {
    const events = record('<label for="p">Password</label><input id="p" type="password">');
    const input = $('#p') as HTMLInputElement;
    typeInto(input, 'hunter2');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events[0]).toMatchObject({ kind: 'fill', sensitive: true });
  });

  it('records a choice in a dropdown by its visible text', () => {
    const events = record('<label for="c">Country</label><select id="c"><option value="in">India</option><option value="fr">France</option></select>');
    const select = $('#c') as HTMLSelectElement;
    select.click();
    select.value = 'fr';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(events).toMatchObject([{ kind: 'select', option: 'France', target: { locator: { label: 'Country' } } }]);
  });

  it('skips the label half of a label click', () => {
    const events = record('<label for="t">Agree</label><input id="t" type="checkbox">');
    $('label').click(); // jsdom, like a browser, follows with a click on the checkbox
    expect(events).toMatchObject([{ kind: 'click', target: { locator: { role: 'checkbox', name: 'Agree' } } }]);
  });

  it('turns the next click into a check, without clicking, from the toolbar', () => {
    let clicked = false;
    const events = record('<h1>Welcome</h1><button>Delete</button>', true);
    $('button').addEventListener('click', () => (clicked = true));
    const host = document.querySelector('heapqa-recorder')!;
    expect(host).not.toBeNull();
    // The toolbar's shadow root is closed; drive it the way a person does, through the recorder's own mode switch.
    (recorder as unknown as { mode: string }).mode = 'expect-text';
    $('h1').click();
    (recorder as unknown as { mode: string }).mode = 'expect-visible';
    $('button').click();
    expect(clicked).toBe(false);
    expect(events).toMatchObject([
      { kind: 'expect-text', text: 'Welcome', target: { locator: { role: 'heading', name: 'Welcome' } } },
      { kind: 'expect-visible', target: { locator: { role: 'button', name: 'Delete' } } },
    ]);
  });
});
