import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker, ActiveSession } from "@cloudflare/puppeteer";

const DEFAULT_AWAIT_NETWORK_IDLE = 1000;
const DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT = 15000;

export interface Env {
	API_TOKEN: string;
	SCRAPPER_BROWSER: Fetcher;
	PAGE_METADATA: D1Database;
	RAW_HTML_BUCKET: R2Bucket;
}

async function generateStorageKey(domain: string, url: string): Promise<string> {
	// Generate hashes for domain and URL
	const domainHash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(domain)
	);
	const urlHash = await crypto.subtle.digest(
		'SHA-256', 
		new TextEncoder().encode(url)
	);

	// Convert hash buffers to hex strings
	const domainHashHex = Array.from(new Uint8Array(domainHash))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
	const urlHashHex = Array.from(new Uint8Array(urlHash))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');

	return `${domainHashHex}/${urlHashHex}`;
}

async function getRandomSession(endpoint: BrowserWorker): Promise<string> {
	const sessions: ActiveSession[] = await puppeteer.sessions(endpoint);
	console.log({ "Message": "Current active sessions", "ActiveSessions": sessions.map((v) => v.sessionId) });
	
	const sessionsIds: string[] = sessions
		.filter((v) => {
			return !v.connectionId; // filter out sessions that are still connected
		})
		.map((v) => {
			return v.sessionId;
		});

	if (sessionsIds.length === 0) {
		console.log({ "Message": "No available sessions", "SessionsIds": sessionsIds });
		return "";
	}

	const sessionId = sessionsIds[Math.floor(Math.random() * sessionsIds.length)];

	return sessionId!;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
		if (apiKey !== env.API_TOKEN) {
			return new Response("Unauthorized", { status: 401 });
		}

		const url = new URL(request.url);
		const reqUrl = url.searchParams.get("url");
		const awaitNetworkIdle = Number(url.searchParams.get("idle")) || DEFAULT_AWAIT_NETWORK_IDLE;

		console.log({ "Message": "Request URL", "URL": reqUrl, "AwaitNetworkIdle": awaitNetworkIdle });

		if (!reqUrl) {
			console.log({ "Message": "URL parameter is missing", "URL": reqUrl });
			return new Response("URL is required", { status: 400 });
		} 

		const targetUrl = new URL(reqUrl);
		const domain = targetUrl.hostname;
		const targetUrlString = targetUrl.toString();

		let sessionId = await getRandomSession(env.SCRAPPER_BROWSER);
		let browser;

		if (sessionId !== "") {
			try {
				console.log({ "Message": "Connecting to session", "SessionId": sessionId });
				browser = await puppeteer.connect(env.SCRAPPER_BROWSER, sessionId);
			} catch (e) {
				console.log({ "Message": "Failed to connect to session", "SessionId": sessionId, "Error": e });
			}
		}

		if (!browser) {
			try {
				console.log({ "Message": "Launching new browser" });
				browser = await puppeteer.launch(env.SCRAPPER_BROWSER);
				sessionId = browser.sessionId();
			} catch (e) {
				console.log({ "Message": "Failed to launch browser", "Error": e });
				return new Response("Failed to launch browser", { status: 500 });
			}
		}

		console.log({ "Message": "Loading page", "URL": targetUrlString });

		const page = await browser.newPage();
		const response = await page.goto(targetUrlString);

		if (response?.status() !== 200) {
			console.log({ "Message": "Failed to load page", "URL": targetUrlString, "Status": response?.status() });
			return new Response("Failed to load page", { status: response?.status() || 500 });
		}

		console.log({ "Message": "Waiting for network idle", "AwaitNetworkIdle": awaitNetworkIdle });

		await page.waitForNetworkIdle({ 
			idleTime: awaitNetworkIdle, 
			timeout: DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT 
		});

		const html = await page.content();
		const title = await page.title();

		await browser.disconnect()

		const r2Key = await generateStorageKey(domain, targetUrlString);
		try {
			// Save the HTML to R2
			const r2Response = await env.RAW_HTML_BUCKET.put(r2Key, html);
			console.log({
				"Message": "Saved HTML to R2",
				"TargetUrl": targetUrlString,
				"Size": html.length,
				"R2Key": r2Key,
				"R2SaveSize": r2Response?.size,
				"R2SaveResult": r2Response?.uploaded,
			});
		} catch (e) {
			console.log({ "Message": "Failed to save HTML to R2", "Error": e });
			return new Response("Failed to save HTML", { status: 500 });
		}

		try {
			// Save the page metadata to D1 using UPSERT
			const d1Response = await env.PAGE_METADATA.prepare(`
				INSERT INTO PageMetadata (url, r2_path, created_at, updated_at) 
				VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
				ON CONFLICT(url) DO UPDATE SET 
					r2_path = excluded.r2_path,
					updated_at = CURRENT_TIMESTAMP
			`)
				.bind(targetUrlString, r2Key)
				.run();
			console.log({
				"Message": "Saved page metadata to D1",
				"TargetUrl": targetUrlString,
				"D1SaveResult": d1Response?.success,
			});
		} catch (e) {
			console.log({ "Message": "Failed to save page metadata to D1", "Error": e });
			return new Response("Failed to save page metadata", { status: 500 });
		}
				
		return new Response(`Scrapped: ${title} - ${targetUrlString}`, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	},
};
