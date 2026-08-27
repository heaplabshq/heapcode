import type { ToolDefinition } from '@heapcode/core/agent';

/**
 * What the agent can do to a page.
 *
 * M2 is read-only on purpose: this is where the loop first runs against a
 * browser, and the blast radius stays exactly zero while that is proven. The
 * mutating half — click, type, select, navigate — lands in M3 together with the
 * permission engine and confirmation UI, because PLAN guardrail 5 says a tool
 * with `permission: 'write'` does not ship without the path that confirms it.
 *
 * Every page-reading tool is `untrustedOutput: true`. The results are whatever
 * an arbitrary website chose to put on screen, arriving while the agent sits
 * beside the user's logged-in session, so core wraps them as data before the
 * model sees them (PRD §6.1).
 */

export const READ_PAGE: ToolDefinition = {
  name: 'read_page',
  description:
    'Read the page the user is currently viewing: its text, its interactive controls with their ' +
    'handles, and any tables. Call this first. After the first call, later calls return only what ' +
    'has changed.',
  parameters: {
    type: 'object',
    properties: {
      full: {
        type: 'boolean',
        description:
          'Force a complete re-read instead of the changes since the last read. Use only if the ' +
          'change summary is not enough to work out the current state.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
};

export const GET_ELEMENTS: ToolDefinition = {
  name: 'get_elements',
  description:
    'List the page controls, optionally filtered by a word in their name — cheaper than a full ' +
    're-read when you only need to find a particular button, field, or link.',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Only return controls whose name or context contains this text.',
      },
      role: {
        type: 'string',
        enum: ['button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
        description: 'Only return controls of this kind.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
};

export const EXTRACT_DATA: ToolDefinition = {
  name: 'extract_data',
  description:
    'Pull the page tables out as structured rows — use this for "list every…", "compare…" or ' +
    '"put these in a table" requests rather than reading the whole page.',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'number',
        description: 'Which table to pull, when the page has more than one. Defaults to the first.',
      },
      limit: {
        type: 'number',
        description: 'Maximum rows to return. Defaults to 50.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
};

export const SCROLL: ToolDefinition = {
  name: 'scroll',
  description:
    'Scroll the page and report what became visible. Use this to reach content below the fold, ' +
    'including pages that load more as you scroll.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
      pages: {
        type: 'number',
        description: 'How many viewport heights to move. Defaults to 1. Ignored for top/bottom.',
      },
    },
    required: ['direction'],
  },
  // Scrolling changes what is visible but nothing about the page's state, and
  // it is how the agent reads a long document at all. Treating it as a write
  // would put a confirmation in front of ordinary reading.
  permission: 'read',
  untrustedOutput: true,
};

export const WAIT: ToolDefinition = {
  name: 'wait',
  description:
    'Wait for the page to settle before reading again — after triggering something that loads ' +
    'content. Returns as soon as the page stops changing, or when the timeout is reached.',
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'How long to wait at most. Defaults to 3, max 15.' },
    },
  },
  permission: 'read',
};

/** The read-only belt, in the order the model should generally reach for them. */
export const READ_ONLY_TOOLS: ToolDefinition[] = [
  READ_PAGE,
  GET_ELEMENTS,
  EXTRACT_DATA,
  SCROLL,
  WAIT,
];
