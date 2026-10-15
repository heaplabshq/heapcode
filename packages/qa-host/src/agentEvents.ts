import type { AgentEvent, AgentEvents } from '@heapcode/core';

/**
 * An in-process agent run's callbacks, as the `AgentEvent` stream Heap Code
 * and Heap Chat render — so Heap QA's AI (writing a flow, healing a step)
 * shows on the page with the same transcript and tool chips, not a copy.
 */
export function agentEventStream(emit: (event: AgentEvent) => void): Partial<AgentEvents> {
  return {
    onText: (text) => emit({ type: 'text', text }),
    onTextDelta: (text) => emit({ type: 'text_delta', text }),
    onTextEnd: () => emit({ type: 'text_end' }),
    onReasoningDelta: (text) => emit({ type: 'reasoning_delta', text }),
    onReasoningEnd: () => emit({ type: 'reasoning_end' }),
    onToolCall: (call) => emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args }),
    // Page outlines run to thousands of characters; the chip shows the start.
    onToolResult: (r) => emit({ type: 'tool_result', id: r.id, name: r.name, content: r.content.slice(0, 4000), ...(r.isError ? { isError: true } : {}) }),
  };
}
