// test/index.spec.ts
import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import worker from '../src/index';
import { Env } from '../src/index';

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Webpage Scrapper worker', () => {
	it('[unit] responds with Unauthorized when no API token is provided', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Unauthorized"`);
	});

	it('[unit] responds with URL is required when no URL is provided', async () => {
		const request = new IncomingRequest('http://example.com', { headers: { 'Authorization': `Bearer ${env.API_TOKEN}` } });
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"URL is required"`);
	});

	it('[integration] responds with Unauthorized when no API token is provided', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Unauthorized"`);
	});

	it('[integration] responds with URL is required when no URL is provided', async () => {
		const response = await SELF.fetch('https://example.com', {
			headers: { 'Authorization': `Bearer ${env.API_TOKEN}` }
		});
		expect(await response.text()).toMatchInlineSnapshot(`"URL is required"`);
	});
});
