import type { HandOver as HandOverRequest } from '../useHandOver.js';
import { Icon } from './Icon.js';

/**
 * The agent stepping aside.
 *
 * Deliberately not shaped like the confirmation or the question. Those two ask
 * the user to *decide* something and the reply is a click. This one asks them
 * to go and *do* something on the page in front of them, and the button only
 * means "I have done it" — so the instruction is the loudest thing here and the
 * button is small, because pressing it before doing the thing is the one way
 * this goes wrong.
 *
 * The wording of the instruction is the model's, addressed to the user. It is
 * rendered as plain text: it is the one place a page's own content could reach
 * a sentence the user is being asked to act on, and it must not be able to
 * bring formatting, a link, or anything else with it.
 */
export function HandOver({
  request,
  onAnswer,
}: {
  request: HandOverRequest;
  onAnswer: (done: boolean) => void;
}) {
  return (
    <div className="prompt-sheet handover" role="alertdialog" aria-label="Your turn on the page">
      <p className="confirm-head">
        <Icon name="pointer" size={13} />
        Over to you
      </p>
      <p className="handover-what">{request.what}</p>
      <p className="confirm-where">
        Do it on the page, then come back. heapbrowse is paused and will carry on from there.
      </p>
      <div className="confirm-actions">
        <button type="button" className="ghost deny" onClick={() => onAnswer(false)}>
          Can&rsquo;t do it
        </button>
        <button type="button" className="primary" onClick={() => onAnswer(true)}>
          Done — carry on
        </button>
      </div>
    </div>
  );
}
