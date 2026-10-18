import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../src/templates.js';

describe('fillTemplate', () => {
  const now = new Date(2026, 9, 19, 14, 5); // local time, as the app shows it

  it('takes the template tag out and fills in the date', () => {
    expect(
      fillTemplate(
        '# Meeting {{date}}\n#template/work #team\n\nOn {{ weekday }} at {{time}}\n#template\n',
        now,
      ),
    ).toBe('# Meeting 2026-10-19\n#team\n\nOn Monday at 14:05\n');
  });

  it('leaves other tags, and words that only start like the tag, alone', () => {
    expect(fillTemplate('#templates and #templateish stay, #template goes', now)).toBe(
      '#templates and #templateish stay, goes',
    );
  });
});
