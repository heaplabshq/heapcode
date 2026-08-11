import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  applyModeToPersona,
  cyclePermissionMode,
  getPermissionModeInfo,
  isPermissionMode,
  resolvePermission,
  resolveUnattended,
  type PermissionMode,
} from '../src/agent/permissionModes.js';
import { filterToolsForPersona, getPersona } from '../src/agent/personas.js';
import type { PermissionClass } from '../src/agent/tools.js';

const CLASSES: PermissionClass[] = ['read', 'write', 'execute', 'destructive'];

describe('resolvePermission', () => {
  it('never prompts for reads, in any mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(resolvePermission('read', mode)).toBe('allow');
    }
  });

  it('denies every mutating class in plan mode', () => {
    expect(resolvePermission('write', 'plan')).toBe('deny');
    expect(resolvePermission('execute', 'plan')).toBe('deny');
    expect(resolvePermission('destructive', 'plan')).toBe('deny');
  });

  it('asks for everything but reads in default mode', () => {
    expect(resolvePermission('write', 'default')).toBe('ask');
    expect(resolvePermission('execute', 'default')).toBe('ask');
    expect(resolvePermission('destructive', 'default')).toBe('ask');
  });

  it('auto-edit allows writes but still asks to run commands', () => {
    expect(resolvePermission('write', 'auto-edit')).toBe('allow');
    expect(resolvePermission('execute', 'auto-edit')).toBe('ask');
    expect(resolvePermission('destructive', 'auto-edit')).toBe('ask');
  });

  /** The safety line for a mode that is one keystroke away. */
  it('full-auto allows writes and commands but still asks before destructive', () => {
    expect(resolvePermission('write', 'full-auto')).toBe('allow');
    expect(resolvePermission('execute', 'full-auto')).toBe('allow');
    expect(resolvePermission('destructive', 'full-auto')).toBe('ask');
  });
});

/**
 * Headless has nobody to prompt. These expectations are the behavior
 * `--permission-mode` shipped with, pinned here because the policy moved into
 * core and the interactive hosts now resolve `ask` differently.
 */
describe('resolveUnattended', () => {
  const table: Array<[PermissionMode, Record<PermissionClass, boolean>]> = [
    ['plan', { read: true, write: false, execute: false, destructive: false }],
    ['default', { read: true, write: false, execute: false, destructive: false }],
    ['auto-edit', { read: true, write: true, execute: false, destructive: false }],
    ['full-auto', { read: true, write: true, execute: true, destructive: true }],
  ];

  for (const [mode, expected] of table) {
    it(`resolves every class for ${mode}`, () => {
      for (const cls of CLASSES) {
        expect(resolveUnattended(cls, mode)).toBe(expected[cls]);
      }
    });
  }

  it('is the only place full-auto may take a destructive action without a human', () => {
    expect(resolvePermission('destructive', 'full-auto')).toBe('ask');
    expect(resolveUnattended('destructive', 'full-auto')).toBe(true);
    expect(resolveUnattended('destructive', 'auto-edit')).toBe(false);
  });
});

describe('cyclePermissionMode', () => {
  it('escalates least- to most-permissive and wraps', () => {
    expect(cyclePermissionMode('plan')).toBe('default');
    expect(cyclePermissionMode('default')).toBe('auto-edit');
    expect(cyclePermissionMode('auto-edit')).toBe('full-auto');
    expect(cyclePermissionMode('full-auto')).toBe('plan');
  });

  it('steps backwards too', () => {
    expect(cyclePermissionMode('plan', -1)).toBe('full-auto');
    expect(cyclePermissionMode('default', -1)).toBe('plan');
  });

  it('returns to a known mode from an unrecognized one', () => {
    expect(cyclePermissionMode('nonsense' as PermissionMode)).toBe('auto-edit');
  });

  it('visits every mode exactly once per full cycle', () => {
    const seen: PermissionMode[] = [];
    let mode: PermissionMode = DEFAULT_PERMISSION_MODE;
    for (let i = 0; i < PERMISSION_MODES.length; i++) {
      seen.push(mode);
      mode = cyclePermissionMode(mode);
    }
    expect(new Set(seen).size).toBe(PERMISSION_MODES.length);
    expect(mode).toBe(DEFAULT_PERMISSION_MODE);
  });
});

describe('applyModeToPersona', () => {
  it('narrows a full-access persona to read-only in plan mode', () => {
    // "agent" carries no allowedPermissions at all, so plan mode has to be
    // what introduces the restriction rather than intersecting into nothing.
    expect(getPersona('agent').allowedPermissions).toBeUndefined();
    const planned = applyModeToPersona(getPersona('agent'), 'plan');
    expect(planned.allowedPermissions).toEqual(['read']);
  });

  it('leaves the persona alone in every other mode', () => {
    for (const mode of ['default', 'auto-edit', 'full-auto'] as const) {
      expect(applyModeToPersona(getPersona('agent'), mode)).toEqual(getPersona('agent'));
    }
  });

  it('cannot widen a persona that is already narrower than architect', () => {
    const debug = getPersona('debug');
    expect(debug.allowedPermissions).toEqual(['read', 'execute']);
    // Plan must take away "execute", never hand back a class debug withheld.
    expect(applyModeToPersona(debug, 'plan').allowedPermissions).toEqual(['read']);
  });

  it('leaves no mutating tool offered once plan mode has narrowed the persona', () => {
    const tools = CLASSES.map((permission) => ({
      name: permission,
      description: '',
      parameters: {},
      permission,
    }));
    const planned = applyModeToPersona(getPersona('agent'), 'plan');
    expect(filterToolsForPersona(tools, planned).map((t) => t.permission)).toEqual(['read']);
  });
});

describe('mode metadata', () => {
  it('recognizes only the four ids', () => {
    for (const mode of PERMISSION_MODES) expect(isPermissionMode(mode)).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  it('has info for every mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(getPermissionModeInfo(mode).id).toBe(mode);
      expect(getPermissionModeInfo(mode).label).toBeTruthy();
    }
  });
});
