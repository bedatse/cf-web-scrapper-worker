import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker, ActiveSession } from "@cloudflare/puppeteer";

export interface Env {
	API_TOKEN: string;
	SCRAPPER_BROWSER: Fetcher;
	PAGE_METADATA: D1Database;
	RAW_HTML_BUCKET: R2Bucket;
}

interface RequestBody {
	url: string;
	idle: number;
	lang: string;
}

const DEFAULT_AWAIT_NETWORK_IDLE = 1000;
const DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT = 15000;
const DEFAULT_LANG = "en";

/*
	Storage key generation

	Generate a unique storage key for the given domain and URL.
	Key format: ${sha1hex(domain)}/${sha256hex(url)}

	Hash is generated using SHA-1 and SHA-256 and converted to a hex string.

	Parameters:
		domain: string - the domain name
		url: string - the URL
*/
async function generateStorageKey(domain: string, url: string): Promise<string> {
	// Generate hashes for domain and URL
	const domainHash = await crypto.subtle.digest(
		'SHA-1',
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

/*
	Session selection

	Get a random active sessions without a worker connection.

	Parameters:
		endpoint: BrowserWorker - the browser worker endpoint
*/
async function getRandomSession(endpoint: BrowserWorker): Promise<string> {
	const sessions: ActiveSession[] = await puppeteer.sessions(endpoint);
	console.log({ "message": "Current active sessions", "ActiveSessions": sessions.map((v) => v.sessionId) });
	
	const sessionsIds: string[] = sessions
		.filter((v) => {
			return !v.connectionId; // filter out sessions that are still connected
		})
		.map((v) => {
			return v.sessionId;
		});

	if (sessionsIds.length === 0) {
		console.log({ "message": "No available sessions", "SessionsIds": sessionsIds });
		return "";
	}

	const sessionId = sessionsIds[Math.floor(Math.random() * sessionsIds.length)];

	return sessionId!;
}

export default {
	/*
		Main handler

		Scrape the given URL, save the HTML to R2 and save the page metadata to D1.

		Parameters:
			request: Request - the request object
			env: Env - the environment variables
	*/
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Check if the request is authorized
		const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
		if (apiKey !== env.API_TOKEN) {
			console.log({ "message": "Unauthorized request", "APIKey": apiKey, "ExpectedAPIKey": env.API_TOKEN });
			return Response.json({"message": "Unauthorized", "status": "failed"}, { status: 401 });
		}

		// Check if the request is POST
		if (request.method !== "POST") {
			console.log({ "message": "Invalid request method", "Method": request.method });
			return Response.json({"message": "Invalid request method", "status": "failed"}, { status: 405 });
		}

		// Get the URL and await network idle time from the request

		const url = new URL(request.url);
		const body: RequestBody = await request.json();
		const reqUrl = body?.url;
		const awaitNetworkIdle = body?.idle || DEFAULT_AWAIT_NETWORK_IDLE;
		const lang = body?.lang || DEFAULT_LANG;

		console.log({ "message": "Request URL", "URL": reqUrl, "AwaitNetworkIdle": awaitNetworkIdle, "Lang": lang });

		// Check if the URL is provided
		if (!reqUrl) {
			console.log({ "message": "URL is missing", "URL": reqUrl });
			return Response.json({"message": "URL is required", "status": "failed"}, { status: 400 });
		} 

		const targetUrl = new URL(reqUrl);
		const domain = targetUrl.hostname;
		const targetUrlString = targetUrl.toString();
		const r2Key = await generateStorageKey(domain, targetUrlString);

		// Get a random active session without a worker connection, and connect to it
		let sessionId = await getRandomSession(env.SCRAPPER_BROWSER);
		let browser;

		if (sessionId !== "") {
			try {
				console.log({ "message": "Connecting to session", "SessionId": sessionId });
				browser = await puppeteer.connect(env.SCRAPPER_BROWSER, sessionId);
			} catch (e: any) {
				console.log({ "message": "Failed to connect to session", "SessionId": sessionId, "Error": e.message });
				console.error(e);
			}
		}

		// If no session is available, launch a new browser
		if (!browser) {
			try {
				console.log({ "message": "Launching new browser" });
				browser = await puppeteer.launch(env.SCRAPPER_BROWSER);
				sessionId = browser.sessionId();
			} catch (e: any) {
				console.log({ "message": "Failed to launch browser", "Error": e.message });
				console.error(e);
				return Response.json({"message": "Failed to launch browser", status: "failed"}, { status: 500 });
			}
		}

		console.log({ "message": "Loading page", "URL": targetUrlString });

		// Create a new page and navigate to the target URL
		const page = await browser.newPage();
		const response = await page.goto(targetUrlString);

		// Check if the page loaded successfully
		if (response?.status() !== 200) {
			console.log({ "message": "Failed to load page", "URL": targetUrlString, "Status": response?.status() });
			return Response.json({"message": "Failed to load page", "status": "failed"}, { status: response?.status() || 500 });
		}

		// Wait for the network to be idle for some website loading information with XHR requests
		console.log({ "message": "Waiting for network idle", "AwaitNetworkIdle": awaitNetworkIdle });

		await page.waitForNetworkIdle({ 
			idleTime: awaitNetworkIdle, 
			timeout: DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT 
		});

		const html = await page.content();
		const title = await page.title();

		// Disconnect from the browser
		await browser.disconnect()

		// Save the HTML to R2
		try {
			const r2Response = await env.RAW_HTML_BUCKET.put(r2Key, html);
			console.log({
				"message": "Saved HTML to R2",
				"TargetUrl": targetUrlString,
				"Size": html.length,
				"R2Key": r2Key,
				"R2SaveSize": r2Response?.size,
				"R2SaveResult": r2Response?.uploaded,
			});
		} catch (e: any) {
			console.log({ "message": "Failed to save HTML to R2", "Error": e.message });
			console.error(e);
			return Response.json({"message": "Failed to save HTML", "status": "failed"}, { status: 500 });
		}

		// Save the page metadata to D1 using UPSERT
		try {
			const d1Response = await env.PAGE_METADATA.prepare(`
				INSERT INTO PageMetadata (url, r2_path, lang, page_crawled_at) 
				VALUES (?, ?, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(url) DO UPDATE SET 
					r2_path = excluded.r2_path,
					lang = excluded.lang,
					page_crawled_at = CURRENT_TIMESTAMP
			`)
				.bind(targetUrlString, r2Key, lang)
				.run();

			console.log({
				"message": "Saved page metadata to D1",
				"TargetUrl": targetUrlString,
				"D1SaveResult": d1Response?.success,
			});
		} catch (e: any) {
			console.log({ "message": "Failed to save page metadata to D1", "Error": e.message });
			console.error(e);
			return Response.json({"message": "Failed to save page metadata", "status": "failed"}, { status: 500 })
		}
		
		// Return a success response
		return Response.json({ "message": "Page scrapped successfully.", "status": "success", "TargetUrl": targetUrlString, "lang": lang, "PageTitle": title }, { status: 200 });
	},
} satisfies ExportedHandler<Env>;
