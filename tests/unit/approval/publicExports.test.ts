import { describe, it, expect } from 'vitest';
import * as sdk from '../../../src/index.js';

describe('approval public exports', () => {
  it('exposes the production pending-action store from the package root', () => {
    // Consumers of the npm package cannot reach internal paths (see package.json#exports).
    expect(typeof sdk.MongoPendingActionStore).toBe('function');
    expect(typeof sdk.InMemoryPendingStore).toBe('function');
  });
});
