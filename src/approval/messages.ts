/**
 * Texts the SDK produces on its own during human-in-the-loop flows: the
 * assistant reply returned when a run is suspended, and the tool-result notes
 * the model sees for pending or skipped calls.
 *
 * Every entry is a template. `{name}` placeholders are replaced with the value
 * of the same name; unknown placeholders are left as they are. Override any
 * subset through `ApprovalConfig.messages` to localize them.
 */
export interface ApprovalMessages {
  /** Reply when exactly one action awaits approval. Placeholders: `{toolName}`. */
  suspendedSingle: string;
  /** Reply when several actions await approval. Placeholders: `{count}`. */
  suspendedMultiple: string;
  /** Tool-result note the model sees for a call that awaits approval. */
  pendingToolResult: string;
  /** Tool-result note for a call skipped while an earlier one awaited approval. */
  skippedToolResult: string;
  /** Reply after approving an action with no resumable checkpoint, when the tool succeeded. Placeholders: `{toolName}`. */
  approvedExecuted: string;
  /** Same as {@link approvedExecuted}, when the tool failed. Placeholders: `{toolName}`. */
  approvedFailed: string;
  /** Reply when a generated plan needs approval before any step runs. Placeholders: `{goal}`, `{steps}`. */
  planRequiresApproval: string;
}

/** English defaults for {@link ApprovalMessages}. */
export const DEFAULT_APPROVAL_MESSAGES: Readonly<ApprovalMessages> = Object.freeze({
  suspendedSingle:
    "The action '{toolName}' requires human approval before continuing. The approvers have been notified.",
  suspendedMultiple: '{count} actions require human approval before continuing.',
  pendingToolResult: 'This action requires human approval. The approvers have been notified.',
  skippedToolResult: 'This action was skipped while an earlier action awaited a decision.',
  approvedExecuted: 'Action approved and executed: {toolName}.',
  approvedFailed: 'Action approved, but its execution failed: {toolName}.',
  planRequiresApproval:
    'The execution plan requires human approval before continuing. Goal: "{goal}". ' +
    'Planned steps: {steps}. Review the plan attached to this response and approve it before execution.',
});

/**
 * Fills `{name}` placeholders in a message template.
 *
 * @param template - Template text.
 * @param values   - Values keyed by placeholder name.
 * @returns The formatted text.
 */
export function formatApprovalMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
