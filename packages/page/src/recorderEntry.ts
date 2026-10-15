import { Recorder, type RecordedEvent } from './recorder.js';

/**
 * What the driver injects into every page while recording. Bundled into one
 * classic script beside the inspect bundle.
 *
 * Top frame only: replay addresses the main page, so a step recorded inside
 * an iframe could not be played back.
 */
type Binding = (event: RecordedEvent | { kind: 'count' }) => Promise<unknown>;

function start(): void {
  if (window !== window.top) return;
  const g = globalThis as unknown as { __heapqaRecord?: Binding; __heapqaRecorder?: Recorder };
  if (g.__heapqaRecorder || !g.__heapqaRecord) return;
  const send = g.__heapqaRecord;
  const recorder = new Recorder(document, (event) => send(event));
  g.__heapqaRecorder = recorder;
  recorder.start({ toolbar: true });
  void send({ kind: 'count' }).then((n) => {
    if (typeof n === 'number') recorder.setTotal(n);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
