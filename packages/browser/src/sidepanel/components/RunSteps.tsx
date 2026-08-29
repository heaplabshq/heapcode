import { useState } from 'react';
import type { Step } from '../useChat.js';
import { ToolChip, ViewChip } from './ToolChip.js';
import { DataTable } from './DataTable.js';
import { Thinking } from './Thinking.js';
import { Icon } from './Icon.js';
import { toolLabel } from '../../shared/toolLabels.js';

/**
 * Everything the agent did, behind one line.
 *
 * A run is ten to thirty steps and the user asked one question. Laid out in
 * full, the answer -- the only part addressed to them -- arrives below a screen
 * and a half of narration, thinking, tool results and screenshots of a page
 * they are already looking at, and they have to scroll past all of it to find
 * what it said. Worse, a model that narrates its conclusion and then repeats it
 * as the summary puts the same paragraph on screen twice, and no amount of
 * de-duplication catches the case where the second one is merely reworded.
 *
 * So the run collapses to a single line, the way a person would report it: what
 * it did, how many times, and a way to look if you want to. The answer sits
 * directly under the question.
 *
 * Open while it is running and closed once it has finished, because those are
 * two different questions -- "what is it doing right now" and "what did it end
 * up saying". Touching the toggle takes it off that rail for good: someone who
 * has opened a finished run wants it open, and having it close itself again on
 * the next render would be the panel arguing with them.
 */
export function RunSteps({ steps, streaming }: { steps: Step[]; streaming?: boolean }) {
  const [choice, setChoice] = useState<boolean>();
  if (steps.length === 0) return null;

  const open = choice ?? Boolean(streaming);
  const actions = steps.filter((step) => step.kind === 'tool').length;

  /**
   * While running, the line names the step in flight in the present tense, from
   * the same table the page's own bar uses -- so the panel and the page say the
   * same thing about the same moment.
   */
  const latest = [...steps].reverse().find((step) => step.kind === 'tool');
  const label =
    streaming && latest?.kind === 'tool'
      ? toolLabel(latest.tool.name).present
      : actions === 0
        ? 'Thought about it'
        : `Worked on the page · ${actions} action${actions === 1 ? '' : 's'}`;

  return (
    <div className={`run${streaming ? ' live' : ''}`} data-open={open}>
      <button
        type="button"
        className="run-head"
        onClick={() => setChoice(!open)}
        aria-expanded={open}
      >
        <Icon name="sparkle" size={13} className="run-glyph" />
        <span className="run-label">{label}</span>
        <Icon name="chevron" size={12} className="run-caret" />
      </button>

      {open && (
        <div className="steps">
          {steps.map((step, s) => {
            if (step.kind === 'tool') return <ToolChip key={step.tool.id} tool={step.tool} />;
            if (step.kind === 'thinking') {
              return <Thinking key={`think-${s}`} text={step.text} streaming={step.streaming} />;
            }
            if (step.kind === 'data') return <DataTable key={`data-${s}`} dataset={step.dataset} />;
            if (step.kind === 'view') return <ViewChip key={`view-${s}`} dataUrl={step.dataUrl} />;
            if (step.kind === 'compacted') {
              return (
                <p key={`compact-${s}`} className="compacted">
                  <Icon name="wait" size={12} />
                  The run outgrew the model&rsquo;s memory, so everything up to here was condensed
                  into a summary.
                </p>
              );
            }
            return (
              <p key={`note-${s}`} className="note">
                {step.text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
