import { Icon } from './Icon.js';

/** One thing typing a slash can reach. */
export interface Command {
  /** What is typed after the slash. */
  slug: string;
  name: string;
  /** One line under the name: what it does, or what to type after it. */
  hint?: string;
  /** Built-ins read differently from things the user made. */
  builtin?: boolean;
}

/**
 * What a slash offers, above the box.
 *
 * A saved workflow needs a way in that is faster than opening a panel and
 * finding it, or it does not get used — and the fastest way in is the one the
 * user is already typing in. Above the composer rather than below it, because
 * the composer sits at the bottom of the panel and a menu below it would open
 * off the screen.
 *
 * Selection is driven from the composer, which owns the keyboard: a menu that
 * handled its own arrow keys would be fighting the textarea for them.
 */
export function SlashMenu({
  commands,
  active,
  onPick,
}: {
  commands: Command[];
  /** Index of the highlighted row. */
  active: number;
  onPick: (command: Command) => void;
}) {
  if (commands.length === 0) return null;

  return (
    <div className="slash" role="listbox" aria-label="Commands">
      {commands.map((command, index) => (
        <button
          key={command.slug}
          type="button"
          role="option"
          aria-selected={index === active}
          className={index === active ? 'slash-item on' : 'slash-item'}
          // `onMouseDown` rather than `onClick`: a click would blur the
          // textarea first, and the composer closes the menu on blur.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command);
          }}
        >
          <Icon name={command.builtin ? 'settings' : 'sparkle'} size={13} className="slash-icon" />
          <span className="slash-text">
            <span className="slash-name">/{command.slug}</span>
            {command.hint && <span className="slash-hint">{command.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
