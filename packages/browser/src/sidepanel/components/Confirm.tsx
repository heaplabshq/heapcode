import type { ConfirmAnswer, ConfirmRequest } from '../../agent/run.js';
import { Icon } from './Icon.js';
import { toolLabel } from '../../shared/toolLabels.js';

/**
 * The question the user answers before anything happens to the page.
 *
 * Deliberately not a dialog with a default button. There is no "OK" to press
 * through: the choices are named for what they do, and the destructive case is
 * visually distinct from the ordinary one, because the whole value of a
 * confirmation is that the two do not look alike.
 *
 * What is shown comes from our own extraction of the element plus a highlight
 * drawn on the page itself -- never the model's description of what it is
 * about to click. A page can name a button one thing and have it do another,
 * and the model only ever saw the name (PRD section 6.1.4).
 */
export function Confirm({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (answer: ConfirmAnswer) => void;
}) {
  const destructive = request.permission === 'destructive';
  const verb =
    request.tool === 'click'
      ? 'Click'
      : request.tool === 'type'
        ? 'Type into'
        : request.tool === 'select'
          ? 'Choose in'
          : request.tool === 'navigate'
            ? 'Go to'
            : 'Go back to';

  return (
    <div
      className={`prompt-sheet${destructive ? ' destructive' : ''}`}
      role="alertdialog"
      aria-label={destructive ? 'Confirm an action that cannot be undone' : 'Confirm an action'}
    >
      <p className="confirm-head">
        <Icon name={destructive ? 'shield' : toolLabel(request.tool).icon} size={13} />
        {destructive ? 'Cannot be undone' : 'Waiting for you'}
      </p>
      <p className="confirm-what">
        <strong>{verb}</strong> {request.target}
      </p>
      <p className="confirm-where">
        on {request.host}
        {/* It is highlighted on the page, so the user can look rather than trust
            the description. Saying so is what makes them look. */}
        {' — outlined on the page'}
      </p>
      {destructive && (
        <p className="confirm-why">
          This looks like it cannot be undone{request.reason ? `: ${request.reason}` : '.'}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="ghost deny" onClick={() => onAnswer('deny')}>
          No
        </button>
        {request.mayAlwaysAllow && (
          <button type="button" onClick={() => onAnswer('always')}>
            Always here
          </button>
        )}
        <button
          type="button"
          className={destructive ? 'danger' : 'primary'}
          onClick={() => onAnswer('allow')}
        >
          {destructive ? 'Yes, do it' : 'Allow'}
        </button>
      </div>
    </div>
  );
}
