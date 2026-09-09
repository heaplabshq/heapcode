/**
 * Switching between Heap Code and Heap Chat.
 *
 * A pair of icon buttons at the top of the rail, the way the Claude app
 * switches between chat and code. It is a real navigation — the two products
 * are different sessions with different tool rosters — but it looks and costs
 * like a tab, because both are served from one origin under one token
 * (`WebHostOptions.mount`). A link to another port would arrive without the
 * HttpOnly cookie and bounce to 401.
 *
 * Rendered only when the other product is actually mounted. A switcher with
 * one working half is worse than no switcher: it teaches people the control
 * is broken rather than that the other product is not running.
 */
export function ProductToggle({ current, chatPath }: { current: 'code' | 'chat'; chatPath: string }): JSX.Element {
  return (
    <div className="product-toggle" role="group" aria-label="Product">
      <a
        className={current === 'chat' ? 'product-tab product-tab-on' : 'product-tab'}
        href={chatPath}
        aria-current={current === 'chat' ? 'page' : undefined}
        title="Heap Chat — your files"
      >
        <IconChat />
        <span className="sr-only">Heap Chat</span>
      </a>
      <a
        className={current === 'code' ? 'product-tab product-tab-on' : 'product-tab'}
        href="/"
        aria-current={current === 'code' ? 'page' : undefined}
        title="Heap Code — this workspace"
      >
        <IconCode />
        <span className="sr-only">Heap Code</span>
      </a>
    </div>
  );
}

function IconChat(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 6.2a3 3 0 0 1 3-3h3.2a3 3 0 0 1 0 6H6l-2.4 2v-2a3 3 0 0 1-1.1-2.3z" strokeLinejoin="round" />
      <path d="M11 7.4a3 3 0 0 1 2.5 3v2.4L11.4 11H9.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconCode(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M5.8 4.5 2.5 8l3.3 3.5M10.2 4.5 13.5 8l-3.3 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
