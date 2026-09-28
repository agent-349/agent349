import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APPROVAL_MESSAGES,
  formatApprovalMessage,
} from '../../../src/approval/messages.js';

describe('formatApprovalMessage', () => {
  it('replaces known placeholders', () => {
    expect(formatApprovalMessage('Tool {toolName}: {count}', { toolName: 'x', count: 2 })).toBe(
      'Tool x: 2',
    );
  });

  it('leaves unknown placeholders untouched', () => {
    expect(formatApprovalMessage('{a} and {b}', { a: '1' })).toBe('1 and {b}');
  });

  it('fills every placeholder used by the default messages', () => {
    const values = { toolName: 't', count: 3, goal: 'g', steps: 2 };
    for (const template of Object.values(DEFAULT_APPROVAL_MESSAGES)) {
      expect(formatApprovalMessage(template, values)).not.toMatch(/\{\w+\}/);
    }
  });
});
