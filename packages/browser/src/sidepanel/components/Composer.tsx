import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SlashMenu, type Command } from './SlashMenu.js';
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
  commands,
  model,
  models,
  onModel,
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
  /** What a slash can reach: the built-ins, plus every saved workflow. */
  commands: Command[];
  /** Which model answers. Undefined until a provider has been configured. */
  model?: string;
  /** Everything the configured endpoint says it can run. */
  models: string[];
  /** Switch model without opening Settings. */
  onModel: (model: string) => void;
  /** Profile and base URL, for the tooltip on the model name. */
  endpoint: string;
  meter: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  /**
   * Which row the arrow keys are on, and whether the menu is up at all.
   *
   * Open is derived from the text rather than stored: a menu whose visibility
   * is separate state is a menu that stays up after the slash has been deleted.
   * `dismissed` is the one thing that cannot be derived — Escape means "not
   * this time", which the text alone cannot say.
   */
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Everything typed so far, when it is a slash and no space has been typed
  // yet. After the space the user is writing arguments, not choosing.
  const typed = /^\/([a-z0-9-]*)$/i.exec(text)?.[1];
  const matches =
    typed === undefined || dismissed
      ? []
      : commands.filter((command) => command.slug.startsWith(typed.toLowerCase())).slice(0, 6);
  const menu = matches.length > 0;

  /** Put the command in the box and leave the cursor after it, ready for detail. */
  const pick = (command: Command) => {
    onText(`/${command.slug} `);
    setDismissed(false);
    setActive(0);
    box.current?.focus();
  };

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
    // The menu takes the keys it needs and passes on the rest, so typing
    // carries on working while it is up.
    if (menu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        pick(matches[Math.min(active, matches.length - 1)]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }

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
      {menu && (
        <SlashMenu commands={matches} active={Math.min(active, matches.length - 1)} onPick={pick} />
      )}
      <div className="composer-box">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => {
            onText(e.target.value);
            // A new slash is a new question; whatever was dismissed is stale.
            setDismissed(false);
            setActive(0);
          }}
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

      {/*
        Which model is answering, how full its window is, and — because the name
        was already here and switching model is the commonest reason anyone
        opened Settings — a way to change it without leaving the conversation.
        Quiet: it is a thing to check far more often than a thing to change.
      */}
      <div className="composer-meta">
        {models.length > 0 ? (
          <span className="meta-model picker" title={endpoint}>
            <span className="meta-model-name">{model ?? 'choose a model'}</span>
            <Icon name="chevron" size={10} className="picker-caret" />
            <select
              value={model ?? ''}
              onChange={(e) => onModel(e.target.value)}
              aria-label="Model"
            >
              {model === undefined && <option value="">Choose a model…</option>}
              {(model && !models.includes(model) ? [model, ...models] : models).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="meta-model" title={endpoint}>
            <span className="meta-model-name">{model ?? 'no model configured'}</span>
          </span>
        )}
        {meter}
      </div>
    </div>
  );
}
