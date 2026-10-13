/**
 * The ARIA role an element has, explicit or implied by its tag.
 *
 * The same roles Playwright's `getByRole` matches on, so a locator written as
 * `{ role: button, name: Save }` from what this returns resolves to the same
 * element when Playwright looks for it. Not the full HTML-AAM table — the
 * elements a test points at, plus the landmarks that make an outline readable.
 */
export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;

  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case 'a':
    case 'area':
      return element.hasAttribute('href') ? 'link' : undefined;
    case 'button':
      return 'button';
    case 'input':
      return inputRole(element as HTMLInputElement);
    case 'textarea':
      return 'textbox';
    case 'select': {
      const select = element as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    case 'option':
      return 'option';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return element.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'form':
      return 'form';
    case 'dialog':
      return 'dialog';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'progress':
      return 'progressbar';
    case 'summary':
      return 'button';
    default:
      return undefined;
  }
}

function inputRole(input: HTMLInputElement): string | undefined {
  switch ((input.getAttribute('type') ?? 'text').toLowerCase()) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    case 'hidden':
    case 'file':
    case 'color':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'time':
    case 'week':
      return undefined;
    // Playwright gives password fields no role either; they are found by label.
    case 'password':
      return undefined;
    default:
      return 'textbox';
  }
}

/** Roles a test acts on, as opposed to ones that only structure the page. */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);
