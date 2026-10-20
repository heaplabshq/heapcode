import type { StepKind } from '../steps.js';

const S = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** One small glyph per kind of step, so a group can be skimmed by shape. */
export function StepIcon({ kind }: { kind: StepKind | 'failed' | 'thinking' }): JSX.Element {
  switch (kind) {
    case 'web':
    case 'search':
      return (
        <svg {...S}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </svg>
      );
    case 'page':
      return (
        <svg {...S}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
        </svg>
      );
    case 'read':
      return (
        <svg {...S}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      );
    case 'change':
      return (
        <svg {...S}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case 'run':
      return (
        <svg {...S}>
          <path d="m5 7 5 5-5 5M12 19h7" />
        </svg>
      );
    case 'make':
      return (
        <svg {...S}>
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
        </svg>
      );
    case 'delegate':
      return (
        <svg {...S}>
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M6 8v4a4 4 0 0 0 4 4h6" />
        </svg>
      );
    case 'remember':
      return (
        <svg {...S}>
          <path d="M6 3h12v18l-6-4-6 4z" />
        </svg>
      );
    case 'connector':
      return (
        <svg {...S}>
          <path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
        </svg>
      );
    case 'thinking':
      return (
        <svg {...S}>
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
        </svg>
      );
    case 'failed':
      return (
        <svg {...S}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );
    default:
      return (
        <svg {...S}>
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}
