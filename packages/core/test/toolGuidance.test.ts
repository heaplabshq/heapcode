import { describe, expect, it } from 'vitest';
import { sharedAgentTools } from '../src/agent/toolDefinitions.js';
import { FINISH_TOOL } from '../src/agent/tools.js';
import { BUILTIN_PERSONAS, getPersona } from '../src/agent/personas.js';

/**
 * What a tool's description tells the model, beyond what the tool does.
 *
 * A description is not documentation — it is the only thing the model reads
 * when choosing between two tools that could both work, and the only place to
 * say which one is wrong. These assertions cover the choices that actually
 * went wrong in real runs: shelling out instead of using a file tool, reading
 * a directory to find something, repeating a `cd` that had already happened,
 * and searching for an answer the codebase did not contain.
 */
describe('choosing between tools', () => {
  const description = (name: keyof typeof sharedAgentTools): string =>
    sharedAgentTools[name].description;

  it('write_file warns that it overwrites, and names the tool for editing', () => {
    // The destructive confusion: reaching for write_file to change part of a
    // file, and deleting everything else in it.
    expect(description('write_file')).toMatch(/edit_file or multi_edit/);
    expect(description('write_file')).toMatch(/Overwrites without warning/);
  });

  it('multi_edit says why it beats a run of edit_file calls', () => {
    expect(description('multi_edit')).toMatch(/cannot leave the file half-changed/);
    expect(description('multi_edit')).toMatch(/one turn instead of five/);
  });

  it('run_command points back at the file tools it is usually standing in for', () => {
    // A real run used `cat | head | sed` to read one file ten times, because
    // read_file could not reach it and nothing suggested going back.
    const d = description('run_command');
    expect(d).toMatch(/read_file over cat/);
    expect(d).toMatch(/edit_file over sed/);
    expect(d).toMatch(/search over grep/);
  });

  it('run_command says the working directory is reported, so cd is not repeated', () => {
    expect(description('run_command')).toMatch(/do not re-issue `cd` you have already run/);
  });

  it('run_command says what happens to a command that never returns', () => {
    expect(description('run_command')).toMatch(/dev server or a watcher, is killed on a timeout/);
  });

  it('semantic_search and search say which question each answers', () => {
    expect(description('semantic_search')).toMatch(/what something does but not what it is called/);
    expect(description('search')).toMatch(/prefer this, semantic_search, or get_symbols/);
  });

  it('list_dir points at the cheaper ways to find something', () => {
    expect(description('list_dir')).toMatch(/repo_map, search or semantic_search/);
  });

  it('web_search and fetch_url both say when to stop searching', () => {
    expect(description('web_search')).toMatch(/Two or three searches settle most questions/);
    expect(description('fetch_url')).toMatch(/One good page beats another five searches/);
  });

  it('check_package_exists says it is not a way to browse a registry', () => {
    // 51 `npm view` calls walking candidate names is the shape this prevents.
    expect(description('check_package_exists')).toMatch(/not a way to browse a registry/);
  });

  it('ask_user says asking beats guessing when the answer changes the work', () => {
    // "Use sparingly" on its own reads as "do not", which is how a run spends
    // 81 searches looking for a decision only the user could make.
    const d = description('ask_user');
    expect(d).toMatch(/asking beats guessing when the answer changes what gets built/);
    expect(d).toMatch(/beats\s+searching for an answer the codebase does not contain/);
  });

  it('delete_file says how far back the undo goes', () => {
    expect(description('delete_file')).toMatch(/no undo beyond the session checkpoint/);
  });

  it('rename_file warns that references are not updated', () => {
    expect(description('rename_file')).toMatch(/References to it elsewhere are not updated/);
  });
});

/**
 * `finish` carries the whole run out of the run.
 *
 * The transcript is discarded when it returns — every file read, every command
 * and its output — so a summary that describes the work instead of its result
 * leaves the next turn with nothing to build on.
 */
describe('the finish tool', () => {
  it('says the summary is the only thing that survives', () => {
    expect(FINISH_TOOL.description).toMatch(/ONLY thing that survives/);
    expect(FINISH_TOOL.description).toMatch(/discarded when this returns/);
  });

  it('covers ending because the task cannot be done', () => {
    expect(FINISH_TOOL.description).toMatch(/cannot\s+be done/);
  });
});

describe('personas', () => {
  const addendum = (id: string): string => getPersona(id).taskAddendum ?? '';

  it('architect is told to be specific rather than exhaustive', () => {
    expect(addendum('architect')).toMatch(/naming the three files to change/);
    expect(addendum('architect')).toMatch(/do not keep reading until certainty arrives/);
  });

  it('debug is told to run something that separates two explanations', () => {
    expect(addendum('debug')).toMatch(/distinguish two explanations/);
    expect(addendum('debug')).toMatch(/which explanations are\s+still open/);
  });

  it('reviewer is told what makes a finding a finding', () => {
    expect(addendum('reviewer')).toMatch(/the input or state that triggers it/);
    expect(addendum('reviewer')).toMatch(/Say plainly when you found nothing serious/);
  });

  it('still says which tools each one has, which is the enforced part', () => {
    for (const persona of BUILTIN_PERSONAS.filter((p) => p.allowedPermissions)) {
      expect(persona.taskAddendum).toMatch(/read-only tools only|file-editing\s+tools are not available/);
    }
  });
});
