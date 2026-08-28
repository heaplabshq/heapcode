import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { BrowserMode } from '../../agent/originPolicy.js';
import { Icon } from './Icon.js';

/**
 * The input, and the ceiling on what pressing it may do.
 *
 * Enter sends, Shift+Enter makes a newline — the convention every chat surface
 * in this portfolio already uses. While a reply is streaming the send button
 * becomes Stop rather than going disabled, so cancelling is always one click
 * from wherever the user's hand already is.
 *
 * The permission mode moved here out of the header. It reads as a property of
 * the run you are about to start rather than of the panel you are sitting in,
 * and in the header it was one of eight controls fighting for a 350px row —
 * where a four-option select truncated to an ambiguous stub. Next to the send
 * button it is unambiguous and it is where the decision is being made.
 *
 * The model and the context meter sit beneath the box for the same reason, and
 * because they are reference rather than navigation: worth being able to check,
 * never worth a line at the top of the panel.
 */

const MODES: { value: BrowserMode; label: string; tone: string }[] = [
  { value: 'read-only', label: 'Read only', tone: 'mode-read' },
  { value: 'confirm', label: 'Ask every time', tone: 'mode-confirm' },
  { value: 'auto-approve', label: 'Ask if risky', tone: 'mode-approve' },
  { value: 'auto', label: "Don't ask", tone: 'mode-auto' },
];

/** Matches `max-height` on `.composer-box textarea`. About eight lines. */
const MAX_HEIGHT = 160;

const MODE_HELP =
  'Read only: never acts.\n' +
  'Ask every time: confirms every action.\n' +
  'Ask if risky: routine clicks and typing go ahead; anything that buys, pays, submits, ' +
  'deletes or leaves the site still asks.\n' +
  "Don't ask: acts without confirming. Banks and password managers are still refused, " +
  'credential fields are still never typed into, and the per-run action limits still apply.';

export function Composer({
  busy,
  disabled,
  text,
  onText,
  onSend,
  onStop,
  mode,
  onMode,
  model,
  endpoint,
  meter,
}: {
  busy: boolean;
  disabled: boolean;
  /**
   * Controlled from above, so the saved-tasks panel can offer to keep whatever
   * is half-typed. State that only one component can see is state nothing else
   * can offer to do anything with.
   */
  text: string;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  mode: BrowserMode;
  onMode: (mode: BrowserMode) => void;
  /** Which model answers. Undefined until a provider has been configured. */
  model?: string;
  /** Profile and base URL, for the tooltip on the model name. */
  endpoint: string;
  meter: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);

  /**
   * Grow with the text, up to the cap the stylesheet sets.
   *
   * A fixed two-row box meant a request longer than about fifteen words was
   * being written into a slot that showed a third of it.
   *
   * The empty case clears the inline height rather than measuring it, and that
   * is the whole of a real bug: measuring an empty textarea before the panel has
   * settled its layout returned a `scrollHeight` from a mid-layout pass, which
   * got written back as an inline height and stuck. Reopening the panel on a
   * finished conversation gave a composer four lines tall with nothing in it.
   * With no text there is nothing to measure, and `rows={1}` already says how
   * tall an empty box should be, so the honest answer is to say nothing.
   *
   * `useLayoutEffect`, so the measurement happens before the browser paints and
   * the box never appears at one size and jumps to another.
   */
  useLayoutEffect(() => {
    const area = box.current;
    if (!area) return;
    if (!text) {
      area.style.height = '';
      return;
    }
    // Reset first, or the box can only ever get taller. Capped here as well as
    // in CSS: the inline value is what a later measurement reads back.
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = () => {
    if (busy || disabled || text.trim().length === 0) return;
    onSend(text);
    onText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const current = MODES.find((entry) => entry.value === mode) ?? MODES[1]!;

  return (
    // Reading the page is no longer a per-message choice: the agent decides
    // when a question needs the page. What gates it is the per-site grant, which
    // is shown in the header and is the thing that actually controls exposure.
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Configure a provider first' : 'Ask about this page…'}
          rows={1}
          disabled={disabled}
        />
        <div className="composer-actions">
          <span className={`mode ${current.tone}`} title={MODE_HELP}>
            <span className="mode-dot" aria-hidden="true" />
            <span className="mode-label">{current.label}</span>
            <Icon name="chevron" size={11} className="mode-caret" />
            <select
              value={mode}
              onChange={(e) => onMode(e.target.value as BrowserMode)}
              aria-label="Permission mode"
            >
              {MODES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </span>

          {busy ? (
            <button type="button" className="send stop" onClick={onStop} aria-label="Stop the run">
              <Icon name="stop" size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={submit}
              disabled={disabled || text.trim().length === 0}
              aria-label="Send"
            >
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Which model is answering, and how full its window is. Quiet, because
          it is a thing to check rather than a thing to do. */}
      <div className="composer-meta">
        <span className="meta-model" title={endpoint}>
          {model ?? 'no model configured'}
        </span>
        {meter}
      </div>
    </div>
  );
}
