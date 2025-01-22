import puppeteer from "@cloudflare/puppeteer";
import type { Browser, Page, ActiveSession } from "@cloudflare/puppeteer";

export interface Env {
	API_TOKEN: string;
	SCRAPPER_BROWSER: Fetcher;
	PAGE_METADATA: D1Database;
	RAW_HTML_BUCKET: R2Bucket;
	SCREENSHOT_BUCKET: R2Bucket;
	SCRAPPER_QUEUE: Queue;
}

export enum ScrapperMode {
	HTML = "html",
	SCREENSHOT = "screenshot",
	ALL = "all",
}

interface RequestBody {
	url: string;
	idle: number;
	lang: string;
	mode: ScrapperMode;
}

const DEFAULT_AWAIT_NETWORK_IDLE = 1000;
const DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT = 30000;
const DEFAULT_LANG = "en";
const DEFAULT_MODE = ScrapperMode.HTML;	

export class WebScrapper {
	private env: Env;
	private browser: Browser | undefined;

	constructor(env: Env) {
		this.env = env;
	}

	/*
		Browser connection

		Get a random active session without a worker connection, and connect to it.
	*/
	async getBrowser() {
		// Get a random active session without a worker connection, and connect to it
		const sessions: ActiveSession[] = await puppeteer.sessions(this.env.SCRAPPER_BROWSER);
		console.log({ "message": "Current active sessions", "ActiveSessions": sessions.map((v) => v.sessionId) });
		
		const sessionsIds: string[] = sessions
			.filter(v => !v.connectionId) // filter out sessions that are still connected
			.map(v => v.sessionId);

		if (sessionsIds.length > 0) {
			const sessionId = sessionsIds[Math.floor(Math.random() * sessionsIds.length)];
			console.log({ "message": "Connecting to session", "SessionId": sessionId });

			try {
				this.browser = await puppeteer.connect(this.env.SCRAPPER_BROWSER, sessionId);
			} catch (e: any) {
				console.log({ "message": "Failed to connect to session", "SessionId": sessionId, "Error": e.message });
				console.error(e);
				// If fail to connect to session, start a new browser session
				// TODO: Add a mechanism to try another vacant session
			}
		} else {
			console.log({ "message": "No available sessions", "SessionsIds": sessionsIds});
		}

		// If no session is available, launch a new browser
		if (!this.browser) {
			console.log({ "message": "Launching new browser" });

			try {
				this.browser = await puppeteer.launch(this.env.SCRAPPER_BROWSER);
			} catch (e: any) {
				console.log({ "message": "Failed to launch browser", "Error": e.message });
				console.error(e);
				throw Error("Failed to launch browser")
			}
		}	
	}

	async cleanup() {
		await this.browser?.disconnect();
	}

	/*
		Storage key generation

		Generate a unique storage key for the given domain and URL.
		Key format: ${sha1hex(domain)}/${sha256hex(url)}

		Hash is generated using SHA-1 and SHA-256 and converted to a hex string.

		Parameters:
			domain: string - the domain name
			url: string - the URL
	*/
	async generateStorageKey(domain: string, url: string): Promise<string> {
		// Generate hashes for domain and URL
		const domainHash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(domain));
		const urlHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));

		// Convert hash buffers to hex strings
		const domainHashHex = Array.from(new Uint8Array(domainHash))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		const urlHashHex = Array.from(new Uint8Array(urlHash))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		return `${domainHashHex}/${urlHashHex}`;
	}
	
	async navigateToPage(targetUrl: string, awaitNetworkIdle: number) {
		if (!this.browser) {
			throw Error("Browser not connected");
		}

		console.log({ "message": "Loading page", "URL": targetUrl });
		// Create a new page and navigate to the target URL
		const page = await this.browser.newPage();

		await page.setViewport({
			width: 1280,
			height: 960,
			deviceScaleFactor: 2,
		});

		const response = await page.goto(targetUrl);

		// Check if the page loaded successfully
		if (response?.status() !== 200) {
			// TODO: If the status is 403 forbidden, put the request to local scrapper queue
			console.log({ "message": "Failed to load page", "URL": targetUrl, "HttpStatus": response?.status(), "ResponseText": response?.text() });
			throw Error("Failed to load page")
		}

		// Wait for the network to be idle for some website loading information with XHR requests
		console.log({ "message": "Waiting for network idle", "AwaitNetworkIdle": awaitNetworkIdle });

		await page.waitForNetworkIdle({ 
			idleTime: awaitNetworkIdle, 
			timeout: DEFAULT_AWAIT_NETWORK_IDLE_TIMEOUT 
		});

		return page;
	}

	async getPageContent(page: Page) {
		const html = await page.content();
		return html;
	}

	async getPageScreenshot(page: Page) {
		const screenshot = await page.screenshot({
			type: "png",
			fullPage: true,
			encoding: "binary"
		});
		return screenshot;
	}

	async saveHTML(r2Key: string, html: string) {
		// Save the HTML to R2
		const r2Response = await this.env.RAW_HTML_BUCKET.put(`${r2Key}.html`, html, {
			httpMetadata: {
				contentType: "text/html",
				contentDisposition: "inline",
			}
		});
		console.log({
			"message": "Saved HTML to R2",
			"Size": html.length,
			"R2Key": r2Key,
			"R2SaveSize": r2Response?.size,
			"R2SaveResult": r2Response?.uploaded,
		});
	}

	async saveScreenshot(r2Key: string, screenshot: Buffer) {
		// Save the screenshot to R2
		const r2Response = await this.env.SCREENSHOT_BUCKET.put(`${r2Key}.png`, screenshot, {
			httpMetadata: {
				contentType: "image/png",
				contentDisposition: "inline",
			}
		});

		console.log({
			"message": "Saved screenshot to R2",
			"Size": screenshot.length,
			"R2Key": r2Key,
			"R2SaveSize": r2Response?.size,
			"R2SaveResult": r2Response?.uploaded,
		});
	}

	async savePageMetadata(r2Key: string, targetUrl: string, lang: string) {
		const d1Response = await this.env.PAGE_METADATA.prepare(`
			INSERT INTO PageMetadata (url, r2_path, lang, page_crawled_at) 
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(url) DO UPDATE SET 
				r2_path = excluded.r2_path,
				lang = excluded.lang,
				page_crawled_at = CURRENT_TIMESTAMP
		`)
			.bind(targetUrl, r2Key, lang)
			.run();

		console.log({
			"message": "Saved page metadata to D1",
			"TargetUrl": targetUrl,
			"D1SaveResult": d1Response?.success,
		});
	}

	async scrapePage(url: string, idle: number, lang: string, mode: ScrapperMode) {
		const targetUrl = new URL(url);
		const domain = targetUrl.hostname;
		const targetUrlString = targetUrl.toString();
		const r2Key = await this.generateStorageKey(domain, targetUrlString);

		const page = await this.navigateToPage(url, idle);

		if (mode === ScrapperMode.HTML || mode === ScrapperMode.ALL) {
			const html = await this.getPageContent(page);
			await this.saveHTML(r2Key, html);
		} 
		
		if (mode === ScrapperMode.SCREENSHOT || mode === ScrapperMode.ALL) {
			const screenshot = await this.getPageScreenshot(page);
			await this.saveScreenshot(r2Key, screenshot);
		}

		await this.savePageMetadata(r2Key, url, lang);
	}
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
		if (request.method !== "POST" && request.method !== "PUT") {
			console.log({ "message": "Invalid request method", "Method": request.method });
			return Response.json({"message": "Invalid request method", "status": "failed"}, { status: 405 });
		}

		// Get the URL and await network idle time from the request
		const body: RequestBody = await request.json();
		const reqUrl = body?.url;
		const awaitNetworkIdle = body?.idle || DEFAULT_AWAIT_NETWORK_IDLE;
		const lang = body?.lang || DEFAULT_LANG;
		const mode = body?.mode || DEFAULT_MODE;
		console.log({ "message": "Request URL", "URL": reqUrl, "AwaitNetworkIdle": awaitNetworkIdle, "Lang": lang });

		// Check if the URL is provided
		if (!reqUrl) {
			console.log({ "message": "URL is missing", "URL": reqUrl });
			return Response.json({"message": "URL is required", "status": "failed"}, { status: 400 });
		} 

		switch (request.method) {
			case "POST":
				const scrapper = new WebScrapper(env);
				try {
					await scrapper.getBrowser();
					const result = await scrapper.scrapePage(reqUrl, awaitNetworkIdle, lang, mode);
					await scrapper.cleanup();
					return Response.json({"message": "Page scrapped successfully.", "status": "success", "targetUrl": reqUrl, "result": result }, { status: 200 });
				} catch (e: any) {
					console.log({ "message": "Failed to scrape page", "Error": e.message });
					console.error(e);
					await scrapper.cleanup();
					return Response.json({"message": "Failed to scrape page", "status": "failed", "targetUrl": reqUrl, "error": e.message}, { status: 500 });
				}
			case "PUT":
				try {
					await env.SCRAPPER_QUEUE.send({
						url: reqUrl,
						idle: awaitNetworkIdle,
						lang: lang,
						mode: mode,
					});
					return Response.json({"message": "Request Accepted", "status": "success", "request": body}, { status: 202 });
				} catch (e: any) {
					console.log({ "message": "Failed to send message to queue", "Error": e.message });
					console.error(e);
					return Response.json({"message": "Failed to send message to queue", "status": "failed"}, { status: 500 });
				}
		}
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		console.log({ "message": "Consuming queue", "BatchSize": batch.messages.length });
		const scrapper = new WebScrapper(env);
		await scrapper.getBrowser();

		for (const message of batch.messages) {
			try {
				const body: RequestBody = message.body as RequestBody;
				const {url, idle, lang, mode} = body;

				await scrapper.scrapePage(url, idle, lang, mode);
				message.ack();
			} catch (e: any) {
				console.log({ "message": "Failed to scrape page", "Error": e.message });
				console.error(e);
				message.retry();
			}
		}
		await scrapper.cleanup();
	}
} satisfies ExportedHandler<Env>;
