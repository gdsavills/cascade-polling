/**
 * Polling adapter.
 *
 * Creates a RouterPlatformAdapter for dispatching synthetic polling events
 * through the existing router infrastructure.
 */

import { GitHubRouterAdapter } from '../router/adapters/github.js';
import { JiraRouterAdapter } from '../router/adapters/jira.js';
import type { RouterPlatformAdapter } from '../router/platform-adapter.js';

/**
 * Get the appropriate router adapter for a provider.
 */
export function getPollingAdapter(provider: 'github' | 'jira'): RouterPlatformAdapter {
	if (provider === 'github') {
		return new GitHubRouterAdapter();
	}
	if (provider === 'jira') {
		return new JiraRouterAdapter();
	}
	throw new Error(`Polling adapter not implemented for provider: ${provider}`);
}
