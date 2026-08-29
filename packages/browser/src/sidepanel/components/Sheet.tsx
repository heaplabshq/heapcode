import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * A pane over the conversation, rather than one shoved into it.
 *
 * Settings, saved tasks and the log used to be inserted between the header and
 * the transcript, which pushed the conversation down the screen -- so opening
 * Settings scrolled away whatever you had opened it to check, and closing it
 * left you somewhere else again. One layer over the top fixes both, and gives
 * the three of them a single shape, a single title position and a single way
 * out.
 *
 * Escape closes it. A pane that covers the conversation has to be dismissible
 * from the keyboard, and that key is the only one anybody tries.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-head">
        <h2 className="sheet-title">{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={`Close ${title}`}>
          <Icon name="close" />
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
