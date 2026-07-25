import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Live terminal column count, reactive to resize.
 *
 * Ink's own resize handling recalculates Yoga layout and re-serializes the
 * *existing* rendered tree — it does not re-invoke React component bodies.
 * That's fine for native Box/Text stretching (Yoga just gets a new width),
 * but any component doing its own width-dependent JS (manual line wrapping,
 * string truncation) needs an actual React re-render to see the new width.
 * This subscribes to the stream's `resize` event (already debounced
 * app-wide in cli.tsx) and mirrors it into state so that JS re-runs too.
 */
export function useTerminalColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns || 80);
  useEffect(() => {
    const onResize = (): void => setColumns(stdout.columns || 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return columns;
}
