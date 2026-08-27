import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpDetached, CdpSession } from '../src/agent/cdp.js';
import { CdpDriver } from '../src/agent/drivers.js';
import { DriverPool } from '../src/agent/driverPool.js';

/**
 * Living with a session Chrome can take away.
 *
 * The debugger is strictly better while it lasts, and Chrome ends it without
 * warning the moment DevTools opens on the tab. That is not an error path, it is
 * the normal one — so what matters is that the run keeps going on the content
 * script rather than reporting a failure the user cannot act on.
 */

interface DebuggerStub {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  fireDetach: () => void;
}

function stubChrome(
  overrides: { attachError?: string; granted?: boolean; noDebuggerApi?: boolean } = {},
): DebuggerStub {
  const listeners: ((source: chrome.debugger.Debuggee) => void)[] = [];
  const attach = overrides.attachError
    ? vi.fn().mockRejectedValue(new Error(overrides.attachError))
    : vi.fn().mockResolvedValue(undefined);
  const detach = vi.fn().mockResolvedValue(undefined);
  const sendCommand = vi.fn().mockResolvedValue({});

  vi.stubGlobal('chrome', {
    debugger: overrides.noDebuggerApi
      ? undefined
      : {
          attach,
          detach,
          sendCommand,
          onDetach: {
            addListener: (fn: (source: chrome.debugger.Debuggee) => void) => listeners.push(fn),
            removeListener: () => {},
          },
        },
    permissions: {
      // Two different grants: host access lets us read the page at all, the
      // `debugger` permission lets us attach. Only the second is optional here.
      contains: vi.fn(async (query: chrome.permissions.Permissions) =>
        query.permissions?.includes('debugger') ? (overrides.granted ?? true) : true,
      ),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]),
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com', title: 'Example' }),
      sendMessage: vi.fn(),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  });

  return { attach, detach, sendCommand, fireDetach: () => listeners.forEach((fn) => fn({ tabId: 1 })) };
}

afterEach(() => vi.unstubAllGlobals());

describe('the session', () => {
  it('enables the domains its data actually comes from', async () => {
    // The accessibility tree is empty until Accessibility is enabled, and
    // backend node ids do not resolve until DOM is.
    const stub = stubChrome();
    await new CdpSession(1).attach();
    const enabled = stub.sendCommand.mock.calls.map((call) => call[1]);
    expect(enabled).toContain('DOM.enable');
    expect(enabled).toContain('Accessibility.enable');
  });

  it('explains the common attach failure instead of relaying a raw error', async () => {
    const stub = stubChrome({ attachError: 'Another debugger is already attached to the tab' });
    const result = await new CdpSession(1).attach();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DevTools/);
    expect(stub.attach).toHaveBeenCalled();
  });

  it('treats being detached as a distinct, recoverable condition', async () => {
    const stub = stubChrome();
    const session = new CdpSession(1);
    await session.attach();

    stub.fireDetach();

    expect(session.attached).toBe(false);
    await expect(session.send('DOM.enable')).rejects.toBeInstanceOf(CdpDetached);
  });

  it('notifies once so the run can carry on elsewhere', async () => {
    const stub = stubChrome();
    const session = new CdpSession(1);
    let lost = 0;
    session.onLost(() => lost++);
    await session.attach();

    stub.fireDetach();
    expect(lost).toBe(1);
  });
});

describe('the pool', () => {
  it('uses the DOM driver when the debugger is switched off', async () => {
    stubChrome();
    const target = await new DriverPool(false).forActiveTab();
    expect(target.ok && target.driver.kind).toBe('dom');
  });

  it('uses the DOM driver when the debugger API is not there at all', async () => {
    // Normally impossible -- `debugger` is a required permission -- but a
    // manifest edit that dropped it should degrade rather than fail as an
    // `undefined` deep inside a run.
    stubChrome({ noDebuggerApi: true });
    const target = await new DriverPool(true).forActiveTab();
    expect(target.ok && target.driver.kind).toBe('dom');
  });

  it('uses CDP when enabled and granted', async () => {
    stubChrome();
    const target = await new DriverPool(true).forActiveTab();
    expect(target.ok && target.driver.kind).toBe('cdp');
  });

  it('falls back for the rest of the run once the session is lost', async () => {
    // Re-attaching would fight whatever took it, and DevTools being open is a
    // deliberate act by the user.
    const stub = stubChrome();
    const messages: string[] = [];
    const pool = new DriverPool(true, (reason) => messages.push(reason));

    const first = await pool.forActiveTab();
    expect(first.ok && first.driver.kind).toBe('cdp');

    stub.fireDetach();

    const second = await pool.forActiveTab();
    expect(second.ok && second.driver.kind).toBe('dom');
    expect(messages[0]).toMatch(/DevTools/);
  });

  it('says what the fallback costs, rather than switching silently', async () => {
    const stub = stubChrome();
    const messages: string[] = [];
    const pool = new DriverPool(true, (reason) => messages.push(reason));
    await pool.forActiveTab();
    stub.fireDetach();

    expect(messages[0]).toMatch(/synthetic/);
    expect(messages[0]).toMatch(/file attachment/i);
  });

  it('detaches on release, so the banner does not outlive the run', async () => {
    // A "Chrome is being debugged" banner still up after the agent has stopped
    // reads to a user as something watching them.
    const stub = stubChrome();
    const pool = new DriverPool(true);
    await pool.forActiveTab();

    await pool.release();

    expect(stub.detach).toHaveBeenCalledWith({ tabId: 1 });
  });
});

describe('handles across calls', () => {
  /**
   * The bug this guards, seen on Amazon: every click failed with "Handle [139]
   * is from an earlier snapshot (generation 1, now 0)". Generation had gone
   * *backwards*, which is impossible for a counter that only increments — and
   * was the tell that it was not the same counter.
   *
   * The pool built a fresh `CdpDriver` on every call, and the registry lives on
   * the driver instance because handles map to backend node ids rather than to
   * anything in the page. So the read registered handles on one object and the
   * click looked them up on another, empty one. `DomDriver` is stateless and
   * survived it, which is why this only appeared once CDP was switched on.
   */
  it('gives the same driver back for the same tab', async () => {
    stubChrome();
    const pool = new DriverPool(true);

    const first = await pool.forActiveTab();
    const second = await pool.forActiveTab();

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.driver).toBe(first.driver);
  });

  it('resolves a handle registered by an earlier call', async () => {
    const stub = stubChrome();
    stub.sendCommand.mockImplementation(async (_target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: '1',
              backendDOMNodeId: 7,
              role: { value: 'link' },
              name: { value: 'NATRAJ sofa' },
              childIds: [],
            },
          ],
        };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageY: 0 } };
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    });

    const pool = new DriverPool(true);

    // Read on one call...
    const reading = await pool.forActiveTab();
    if (!reading.ok) throw new Error('expected a driver');
    const page = await reading.driver.snapshot();
    expect(page.controls).toHaveLength(1);

    // ...act on the next, exactly as the executor does.
    const acting = await pool.forActiveTab();
    if (!acting.ok) throw new Error('expected a driver');
    const result = await acting.driver.click(page.controls[0]!.handle, page.generation);

    expect(result.ok).toBe(true);
  });

  it('replaces the driver when the session is lost, so its dead registry goes too', async () => {
    const stub = stubChrome();
    const pool = new DriverPool(true);

    const before = await pool.forActiveTab();
    expect(before.ok && before.driver.kind).toBe('cdp');

    stub.fireDetach();

    const after = await pool.forActiveTab();
    expect(after.ok && after.driver.kind).toBe('dom');
  });
});

describe('the CDP driver', () => {
  it('clicks with real input events at the element centre', async () => {
    const stub = stubChrome();
    const session = new CdpSession(1);
    await session.attach();

    stub.sendCommand.mockImplementation(async (_target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: '1',
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'Apply' },
              childIds: [],
            },
          ],
        };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageY: 0 } };
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      return {};
    });

    const driver = new CdpDriver(session);
    const page = await driver.snapshot();
    const result = await driver.click(page.controls[0]!.handle, page.generation);

    expect(result.ok).toBe(true);
    const dispatched = stub.sendCommand.mock.calls
      .filter((call) => call[1] === 'Input.dispatchMouseEvent')
      .map((call) => (call[2] as { type: string }).type);
    // A real press and release, not element.click() — which is the whole point.
    expect(dispatched).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    const press = stub.sendCommand.mock.calls.find(
      (call) => (call[2] as { type?: string })?.type === 'mousePressed',
    );
    expect(press?.[2]).toMatchObject({ x: 20, y: 30 });
  });

  it('refuses a handle it never issued', async () => {
    const stub = stubChrome();
    const session = new CdpSession(1);
    await session.attach();
    stub.sendCommand.mockResolvedValue({ nodes: [] });

    const driver = new CdpDriver(session);
    await driver.snapshot();
    const result = await driver.click(1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Read the page first/);
  });

  it('refuses handles once the page has moved to another site', async () => {
    // The case expiry was really guarding, and the one a counter cannot tell
    // apart from a harmless re-render.
    const stub = stubChrome();
    const session = new CdpSession(1);
    await session.attach();
    stub.sendCommand.mockImplementation(async (_t, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Apply' }, childIds: [] },
          ],
        };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageY: 0 } };
      }
      return {};
    });

    const driver = new CdpDriver(session);
    const page = await driver.snapshot();

    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      url: 'https://elsewhere.example/other',
      title: 'Elsewhere',
    });

    const result = await driver.click(page.controls[0]!.handle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/moved from/);
  });
});
