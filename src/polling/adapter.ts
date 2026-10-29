/**
 * Polling adapter.
 *
 * Creates a RouterPlatformAdapter for dispatching synthetic polling events
 * through the existing router infrastructure.
 */

import { GitHubRouterAdapter } from '../router/adapters/github.js';
import type { RouterPlatformAdapter } from '../router/platform-adapter.js';

/**
 * Get the appropriate router adapter for a provider.
 * Currently only GitHub is supported for polling.
 */
export function getPollingAdapter(provider: 'github' | 'jira'): RouterPlatformAdapter {
	if (provider === 'github') {
		return new GitHubRouterAdapter();
	}
	// JIRA adapter will be added when Jira poller is implemented
	throw new Error(`Polling adapter not implemented for provider: ${provider}`);
}
