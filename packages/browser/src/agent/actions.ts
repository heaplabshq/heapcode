import type { ToolDefinition } from '@heapcode/core/agent';

/**
 * The mutating half of the belt.
 *
 * Each of these lands with its confirmation path, never before it (PLAN
 * guardrail 5). The permission class on each is only a floor: the real class is
 * inferred per call from what the element actually is, because `click` on a
 * filter and `click` on "Place order" are the same tool call with very
 * different consequences (see destructive.ts).
 *
 * `upload_file` is specified in the PRD and deliberately absent: `input.files`
 * cannot be set from page context without `chrome.debugger`, so the agent fills
 * the rest of a form and hands the upload back to the user (PRD section 7.4).
 */

const HANDLE = {
  type: 'number',
  description:
    'The handle number of the control, from the most recent read of the page. Handles expire ' +
    'whenever the page changes, so read the page again if you have acted since.',
};

export const CLICK: ToolDefinition = {
  name: 'click',
  description:
    'Click a control on the page. The user is shown what will be clicked and must approve it ' +
    'before anything happens.',
  parameters: {
    type: 'object',
    properties: { handle: HANDLE },
    required: ['handle'],
  },
  permission: 'write',
};

export const TYPE: ToolDefinition = {
  name: 'type',
  description:
    'Type text into a field. Never works on password, one-time-code or payment fields -- those ' +
    'are refused outright and must be filled by the user.',
  parameters: {
    type: 'object',
    properties: {
      handle: HANDLE,
      text: { type: 'string', description: 'The text to put in the field. Replaces what is there.' },
    },
    required: ['handle', 'text'],
  },
  permission: 'write',
};

export const SELECT: ToolDefinition = {
  name: 'select',
  description: 'Choose an option in a dropdown. Use one of the options listed for that control.',
  parameters: {
    type: 'object',
    properties: {
      handle: HANDLE,
      option: { type: 'string', description: 'The option text to choose.' },
    },
    required: ['handle', 'option'],
  },
  permission: 'write',
};

export const NAVIGATE: ToolDefinition = {
  name: 'navigate',
  description:
    'Go to a URL in the current tab. Leaving the current site always needs the user to approve it.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Where to go. May be relative.' } },
    required: ['url'],
  },
  permission: 'write',
};

export const GO_BACK: ToolDefinition = {
  name: 'go_back',
  description: 'Go back to the previous page.',
  parameters: { type: 'object', properties: {} },
  permission: 'write',
};

/**
 * Press a key, which is not the same thing as typing.
 *
 * `type` puts text in a field and stops there. A search box that submits on
 * Enter, a combobox driven by arrow keys, a dialog that closes on Escape and a
 * form navigated with Tab are all unreachable without this, and the agent's
 * workaround -- hunting for a submit button that may not exist -- is where a lot
 * of runs used to die.
 */
export const PRESS_KEY: ToolDefinition = {
  name: 'press_key',
  description:
    'Press a key. Use "Enter" to submit a search or a form, "Escape" to close a dialog, "Tab" to ' +
    'move to the next field, or an arrow key to move through a dropdown. A chord may be written as ' +
    'one string, such as "Ctrl+A". Give a handle to focus that control first; omit it to send the ' +
    'key wherever the focus already is.',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'The key: Enter, Tab, Escape, Backspace, Delete, an arrow key, Home, End, PageUp, ' +
          'PageDown, Space, or a single character.',
      },
      handle: { type: 'number', description: 'Optional control to focus before pressing.' },
    },
    required: ['key'],
  },
  permission: 'write',
};

/**
 * Fill several fields in one call.
 *
 * A form of eight fields was eight tool calls, each one a full model round trip
 * and, in ask mode, a separate confirmation. That is slow enough that people
 * stopped using the agent for the task it is best at, and the stream of
 * confirmations is exactly what teaches someone to approve without reading.
 *
 * Each field is still classified individually, and a credential field is still
 * refused outright -- batching changes how many times the user is asked, never
 * what the rules are.
 */
export const FILL_FORM: ToolDefinition = {
  name: 'fill_form',
  description:
    'Fill several fields at once. Give each field its handle and the value to put in it; for a ' +
    'dropdown, give the option text. Faster and less disruptive than one call per field. Password, ' +
    'one-time-code and payment fields are refused, as always.',
  parameters: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'The fields to fill, in order.',
        items: {
          type: 'object',
          properties: {
            handle: { type: 'number', description: 'The handle number of the field.' },
            value: { type: 'string', description: 'The text to type, or the option to choose.' },
            detail: {
              type: 'string',
              description:
                'Instead of a value, the name of one of the user\'s saved details to put here — ' +
                '"Email address", "Phone number". You never see the value; it is filled in locally.',
            },
          },
          required: ['handle'],
        },
      },
    },
    required: ['fields'],
  },
  permission: 'write',
};

/**
 * Fill everything the user has already told us, in one go.
 *
 * The matching is done here, not by the model: the page says what each field
 * wants (`autocomplete`) or what it is called, and that is matched against the
 * saved details locally. The model asks for the form to be filled and is told
 * which details went where -- by name, never by value.
 *
 * It is deliberately not "fill in the form". It fills the fields it is sure
 * about and reports the rest as unfilled, so the model asks the user about the
 * genuinely unknown ones instead of inventing them.
 */
export const AUTOFILL_FORM: ToolDefinition = {
  name: 'autofill_form',
  description:
    "Fill the fields on this page that match the user's saved details — their name, email, phone, " +
    'address, and so on. Reports which fields it filled and which it could not match, so you can ' +
    'ask about the rest. Use this before filling a form by hand.',
  parameters: { type: 'object', properties: {} },
  permission: 'write',
};

/**
 * The next page of a list.
 *
 * Pagination is fiddly in a way that is invisible until an agent tries it. The
 * control is called "Next", or "›", or "2", or nothing at all with an
 * `aria-label`; it is sometimes a link, sometimes a button, sometimes neither;
 * and half the sites that have one also encode the page in the URL, where
 * changing a number is far more reliable than clicking anything. Left to work
 * this out from the control list, a model reliably clicks "1" on page one, or
 * re-clicks the same control and reports progress it did not make.
 *
 * So it is a tool. It finds the control, or falls back to the URL, and says
 * which it did -- and says plainly when there is no next page, which is the
 * answer that ends a collection loop instead of spinning it.
 */
export const NEXT_PAGE: ToolDefinition = {
  name: 'next_page',
  description:
    'Go to the next page of a list of results. Finds the pagination control, or changes the page ' +
    'number in the URL when the page has one. Tells you when there is no next page. Follow it with ' +
    'extract_data to add that page to what you have collected.',
  parameters: { type: 'object', properties: {} },
  permission: 'write',
};

export const OPEN_TAB: ToolDefinition = {
  name: 'open_tab',
  description:
    'Open a URL in a new tab and start working in it. The tab you were in stays where it is, so ' +
    'this is how to compare two pages or keep a list of results while following one of them.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The address to open.' },
      background: {
        type: 'boolean',
        description: 'Open it without bringing it to the front. Defaults to false.',
      },
    },
    required: ['url'],
  },
  permission: 'write',
};

export const CLOSE_TAB: ToolDefinition = {
  name: 'close_tab',
  description:
    'Close a tab. Only close tabs you opened yourself -- the others belong to the user and closing ' +
    'one loses whatever was in it.',
  parameters: {
    type: 'object',
    properties: { tab: { type: 'number', description: 'The tab number, from list_tabs.' } },
    required: ['tab'],
  },
  permission: 'write',
};

/**
 * Drag one element onto another.
 *
 * Needs the debugger, and is offered only when it is active: a drag is a stream
 * of pointer positions the page tracks frame by frame, and a synthesized
 * sequence is ignored by every implementation worth dragging in.
 */
export const DRAG: ToolDefinition = {
  name: 'drag',
  description:
    'Drag one element onto another — to reorder a list, move a card, or drop something into a ' +
    'target area.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'number', description: 'The handle of the element to drag.' },
      to: { type: 'number', description: 'The handle of where to drop it.' },
    },
    required: ['from', 'to'],
  },
  permission: 'write',
};

/**
 * Attach a file the user has already configured.
 *
 * Not offered unless the debugger is active: `HTMLInputElement.files` cannot be
 * set from page context by design, so without CDP this is impossible rather than
 * merely awkward (PRD section 7.4).
 *
 * The model picks *which* configured file, never a path. A model that could name
 * arbitrary paths would be a model that could read arbitrary files off the
 * machine, and the page it is reading gets to influence what it asks for.
 */
export const ATTACH_FILE: ToolDefinition = {
  name: 'attach_file',
  description:
    'Attach one of the user\'s configured files (such as their CV) to a file input on the page. ' +
    'Only the files the user has set up can be attached; you cannot name an arbitrary path.',
  parameters: {
    type: 'object',
    properties: {
      handle: HANDLE,
      file: {
        type: 'string',
        description: 'Which configured file to attach, by name. Omit when only one is configured.',
      },
    },
    required: ['handle'],
  },
  permission: 'write',
};

export const MUTATING_TOOLS: ToolDefinition[] = [
  CLICK,
  TYPE,
  FILL_FORM,
  SELECT,
  PRESS_KEY,
  NAVIGATE,
  GO_BACK,
  NEXT_PAGE,
  OPEN_TAB,
  CLOSE_TAB,
];
