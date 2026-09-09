import { sharedAgentTools, type ToolDefinition } from '@heapcode/core';
import { CREATE_ARTIFACT_TOOL } from '@heapcode/web-host';

/**
 * Heap Chat's tool roster.
 *
 * A **separate array**, not `agentToolDefinitions` behind a filter. That is
 * the guardrail in docs/CHAT_MODE_PLAN.md §Guardrails 2, and it is not
 * stylistic: a filtered shared array means every tool added for Heap Code is
 * offered to Heap Chat until someone remembers to exclude it, and the failure
 * is silent in the direction that matters — a knowledge assistant quietly
 * gaining `run_command`.
 *
 * The **schema and permission class** come from core, because those must not
 * drift from the executor that runs the call. The **description does not**,
 * and an earlier version of this file was wrong to reuse it. Core's prose is
 * written for a coding agent and names tools this roster does not have:
 * `read_file` explains what to do after `edit_file`, `list_dir` recommends
 * `repo_map`, `search` recommends `multi_edit`, `fetch_url` mentions
 * `run_command`. An integration test caught it in the system prompt — the
 * model was being told about five tools it could not call, in a product whose
 * own prompt says it has nothing that changes anything.
 *
 * Deliberately absent, and not oversights: every write, edit, delete and
 * rename tool, `run_command`, `run_tests`, `repo_map`, `get_symbols`,
 * `download_file`, `multi_edit`, `create_directory` and `delegate_task`.
 *
 * **Heap Chat never changes the folder it is pointed at.** That is a product
 * decision, not a missing feature. These are someone's documents — a tenancy
 * agreement, a scan of a certificate, six years of bank exports — and an
 * assistant that edits them in place is one bad edit away from destroying
 * something with no other copy. Heap Code writes to a repo because a repo has
 * git; a documents folder has nothing.
 *
 * What it CAN produce goes to `create_artifact`: a summary, an extracted
 * table, a written note. Artifacts live under the state directory, beside the
 * conversation and outside the folder, and the person saves one into their own
 * files when they want it — an explicit act, on their terms. Nothing is
 * overwritten, so there is nothing to diff and nothing to revert.
 */
/**
 * Heap Chat's own tool — no shared definition to reuse, because Heap Code has
 * no equivalent: its memory is a file in the repo that the user edits, plus a
 * distillation step that proposes notes at the end of a session. This is the
 * other shape, the one a conversational assistant needs: the person says
 * "remember that…" and it is remembered now.
 *
 * `write` class, and honestly so. It is the one thing on this roster that
 * changes state — not in the folder, which stays untouched, but in what the
 * assistant will know tomorrow.
 */
/** Core's definition with prose written for this product instead of for a codebase. */
function described(tool: ToolDefinition, description: string): ToolDefinition {
  return { ...tool, description };
}

export const REMEMBER_TOOL: ToolDefinition = {
  name: 'remember',
  description:
    'Save a durable fact about this person for future conversations — a preference, a constraint, a ' +
    'name or relationship, something they asked you to remember. Use it when they say "remember that…", ' +
    'and sparingly on your own: only for things that will still be true and still matter next month. ' +
    'Not for anything specific to the current question, and not for facts about the FILES — those are ' +
    'in the files already and re-reading them is cheap.',
  parameters: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description: 'One fact, in a single sentence, written so it makes sense with no other context.',
      },
    },
    required: ['fact'],
  },
  permission: 'write',
};

export const chatToolDefinitions: ToolDefinition[] = [
  described(
    sharedAgentTools.read_file,
    'Read a file, or a line range of it. Returns its content with line numbers. PDFs, Word documents ' +
      'and photos are converted to text first, so this is how you read those too — a photo comes back ' +
      'as a description of what it shows. Read the part you need: when you know roughly where ' +
      'something is, a range beats the whole file.',
  ),
  // Added after C4: "is there a receipt photo in this folder?" is not
  // answerable without being able to look. The roster's five had no way to
  // enumerate anything, so the model fell back to `search` with a pattern of
  // "." and reasoned about whatever that happened to match — which for a PNG
  // is nothing, so it concluded the photo did not exist.
  described(
    sharedAgentTools.list_dir,
    'List the files and folders at a path inside this folder (not recursive). Use it to see what is ' +
      'actually here — especially before saying something is not, since a search cannot see inside ' +
      'PDFs, documents or photos.',
  ),
  described(
    sharedAgentTools.search,
    'Search file contents with a regular expression. Returns file:line matches with a little context ' +
      'around each. Good for an exact string — an invoice number, a surname, a date. It reads raw ' +
      'bytes, so it cannot see inside a PDF, a Word document or a photo; use semantic_search for those.',
  ),
  described(
    sharedAgentTools.semantic_search,
    'Search this folder by meaning rather than by exact wording — "what did I agree about the ' +
      'deposit". Reaches the contents of PDFs, Word documents and photos as well as plain text, which ' +
      'a regex search cannot. Use it whenever the question is about what something says rather than ' +
      'what it is called.',
  ),
  // Always offered, executed only when configured — the same posture Heap Code
  // takes. A model that cannot see the tool has no way to know web search is a
  // concept here, and one that cannot see it will claim it searched anyway.
  described(
    sharedAgentTools.web_search,
    'Search the web. Only for questions the files cannot answer — check this folder first, and say ' +
      'plainly when an answer came from the web rather than from the person\'s own documents.',
  ),
  described(
    sharedAgentTools.fetch_url,
    'Fetch a web page and read it as text. Use it when the person gives you a link, or to read a page ' +
      'a web search turned up. One good page beats another five searches.',
  ),
  // Not a further capability over the folder — it is how the run talks back.
  // The plan's C0 named five tools; this one earns its place because the
  // loop gates `askToContinueAtLimit` on the roster containing `ask_user`
  // (agent/loop.ts:951), so without it both that and `chat/askUser` are
  // protocol that can never fire. Executed by the session, not the executor.
  sharedAgentTools.ask_user,
  // Producing something to look at — and, if the person wants it, to save.
  // This is the whole of "writing" in this product.
  described(
    CREATE_ARTIFACT_TOOL,
    'Produce a document beside the conversation — a written summary, an extracted table, a report, a ' +
      'chart. Use it whenever the person asks you to write, draft, extract or compile something, rather ' +
      'than pasting a long answer into the chat. They can read it beside the conversation and save it ' +
      'into their own files if they want it. Pass the same id again to revise one you already made. ' +
      'You cannot change the files in this folder, and should not offer to — this is how you give them ' +
      'something new instead.',
  ),
  REMEMBER_TOOL,
];

/** Tool names this host will execute. Anything else is refused, not attempted. */
export const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(chatToolDefinitions.map((t) => t.name));
