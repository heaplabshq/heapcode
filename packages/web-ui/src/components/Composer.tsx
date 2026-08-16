import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { matchCommands, type Command } from '../commands.js';

/** Matches the host's own cap (`session.ts` MAX_IMAGES) so the two agree. */
const MAX_IMAGES = 8;
/** Roughly the host's MAX_IMAGE_BYTES, checked before the base64 expansion. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface ComposerProps {
  onSend(text: string, images?: string[]): void;
  onCancel(): void;
  busy: boolean;
  disabled?: boolean;
  /** The bar under the input: permission mode on the left, model on the right. */
  footer?: ReactNode;
  /** Surfaced by the parent as a banner — a rejected drop must say why. */
  onReject?(reason: string): void;
  /**
   * Text to drop into the box and focus, used by the global `/` shortcut.
   * Cleared through `onSeedUsed` so the same seed can be sent again later.
   */
  seed?: string;
  onSeedUsed?(): void;
}

/**
 * The input.
 *
 * Enter sends, Shift+Enter and Option/Alt+Enter insert a newline, Escape
 * cancels a run in flight — the same protocol the terminal UI uses, so muscle
 * memory carries between the two.
 *
 * It also takes images, by paste or by drop. That is the one thing this
 * composer can do that the terminal one cannot, and it is why screenshots stop
 * being something you describe in words.
 */
export function Composer({
  onSend,
  onCancel,
  busy,
  disabled,
  footer,
  onReject,
  seed,
  onSeedUsed,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState(0);
  /** Escape closes the menu without closing anything else; typing reopens it. */
  const [menuDismissed, setMenuDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * The slash menu.
   *
   * Only while the *first token* is being typed: once there is a space, the
   * user has moved on to arguments (`/search foo`) and a list of commands over
   * the box is in the way rather than in the way of a mistake.
   */
  const firstToken = text.split(/\s/)[0] ?? '';
  const typingCommand = text.startsWith('/') && !/\s/.test(text) && !text.includes('\n');
  const matches: Command[] = typingCommand ? matchCommands(firstToken) : [];
  const menuOpen = matches.length > 0 && !menuDismissed && !busy && !disabled;
  const selected = matches[Math.min(picked, matches.length - 1)];

  // Grow with the content, up to a cap, instead of scrolling a two-line box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  // The global `/` shortcut lands here. It cannot just focus the box and let
  // the keystroke through: the handler has to preventDefault to stop `/` from
  // triggering the browser's own quick-find, so the character has to be put in
  // deliberately or pressing `/` would focus an empty box and eat the slash.
  useEffect(() => {
    if (seed === undefined) return;
    setText(seed);
    setMenuDismissed(false);
    setPicked(0);
    ref.current?.focus();
    onSeedUsed?.();
  }, [seed, onSeedUsed]);

  // A new query is a new list; keeping the old index would leave the highlight
  // on whatever row happened to be in that position.
  useEffect(() => setPicked(0), [firstToken]);

  const send = (value = text): void => {
    const trimmed = value.trim();
    // An image with no words is a real message — "what is wrong with this?" is
    // implied — so the guard is "nothing at all", not "no text".
    if ((!trimmed && images.length === 0) || busy || disabled) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    setText('');
    setImages([]);
    setMenuDismissed(false);
  };

  /**
   * Take the highlighted command.
   *
   * One that takes arguments completes into the box and waits, because firing
   * `/search` with no query can only answer "usage: …". One that does not runs
   * immediately — making someone press Enter twice for `/new` is the kind of
   * politeness nobody asked for.
   */
  const accept = (command: Command, run: boolean): void => {
    if (command.args) {
      setText(`${command.name} `);
      setMenuDismissed(true);
      ref.current?.focus();
      return;
    }
    if (run) send(command.name);
    else {
      setText(command.name);
      setMenuDismissed(true);
      ref.current?.focus();
    }
  };

  /** Files → data URLs, with the count and size caps applied before reading. */
  const addFiles = async (files: File[]): Promise<void> => {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (pictures.length === 0) {
      if (files.length > 0) onReject?.('Only images can be attached — drop a file path into the message instead.');
      return;
    }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      onReject?.(`At most ${MAX_IMAGES} images per message.`);
      return;
    }
    const accepted: string[] = [];
    for (const file of pictures.slice(0, room)) {
      if (file.size > MAX_IMAGE_BYTES) {
        onReject?.(`${file.name || 'That image'} is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`);
        continue;
      }
      accepted.push(await readAsDataUrl(file));
    }
    if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    void addFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="composer">
      {/* Above the box, not below it: the box is already at the bottom of the
          window, so a list under it would open off-screen. */}
      {menuOpen && (
        <ul className="slash-menu" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <li key={c.name} id={`slash-${c.name.slice(1)}`} role="option" aria-selected={c === selected}>
              <button
                className={`slash-item${c === selected ? ' slash-item-active' : ''}`}
                tabIndex={-1}
                onMouseEnter={() => setPicked(i)}
                // mousedown, not click: the textarea would blur first and the
                // list would unmount before the click ever landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(c, true);
                }}
              >
                <span className="slash-name">
                  {c.name}
                  {c.args && <span className="slash-args"> {c.args}</span>}
                </span>
                <span className="slash-desc">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`composer-box${dragging ? ' composer-box-drop' : ''}`}
        onDragOver={(e) => {
          // Only claim the drop when it is actually files; otherwise the
          // browser's own text-drop behavior is the better one.
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {images.length > 0 && (
          <div className="attachments" aria-label={`${images.length} attached image(s)`}>
            {images.map((src, i) => (
              <div className="attachment" key={`${i}-${src.slice(24, 48)}`}>
                <img src={src} alt={`Attachment ${i + 1}`} />
                <button
                  className="attachment-remove"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove attachment ${i + 1}`}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled ? 'Connecting…' : busy ? 'Running — Esc to stop' : 'Ask anything, / for commands, paste an image'
          }
          aria-label="Message"
          // Combobox over the slash menu when it is up: the input keeps focus
          // and announces which row is active, rather than moving focus into a
          // list that unmounts as soon as you type the next character.
          role={menuOpen ? 'combobox' : undefined}
          aria-expanded={menuOpen || undefined}
          aria-activedescendant={menuOpen && selected ? `slash-${selected.name.slice(1)}` : undefined}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length === 0) return;
            // Only swallow the paste when it really carried files; a paste that
            // is text plus an image should still insert the text.
            if (files.some((f) => f.type.startsWith('image/'))) e.preventDefault();
            void addFiles(files);
          }}
          onChange={(e) => {
            setText(e.target.value);
            // Typing after dismissing reopens the menu — the dismissal was
            // about the list that was on screen, not about this command.
            setMenuDismissed(false);
          }}
          onKeyDown={(e) => {
            // The menu owns these keys while it is up, and nothing else sees
            // them — otherwise Enter would send `/hel` to the model.
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPicked((i) => Math.min(i + 1, matches.length - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPicked((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === 'Tab' && selected) {
                e.preventDefault();
                accept(selected, false);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && selected) {
                e.preventDefault();
                accept(selected, true);
                return;
              }
              if (e.key === 'Escape') {
                // Closes the list, not the run: Stop is still Escape once the
                // menu is out of the way.
                e.preventDefault();
                setMenuDismissed(true);
                return;
              }
            }
            if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onCancel();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button className="btn btn-danger" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary"
              // Wrapped, not passed by reference: `send` now takes an optional
              // text argument, and onClick would hand it a MouseEvent.
              onClick={() => send()}
              disabled={(!text.trim() && images.length === 0) || disabled}
            >
              Send
            </button>
          )}
        </div>
      </div>
      {footer && <div className="composer-bar">{footer}</div>}
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}
