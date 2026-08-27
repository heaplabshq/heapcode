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

export const MUTATING_TOOLS: ToolDefinition[] = [CLICK, TYPE, SELECT, NAVIGATE, GO_BACK];
