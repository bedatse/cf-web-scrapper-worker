# Webpage Scrapper for Web-based Retrieval Augmented Content Composer

This is a web scraper that scrapes public web pages using Cloudflare Workers, storing the HTML in R2 and the page metadata in D1.

## Usage

```curl https://{CF_Worker_Domain}/?url={URL}&idle={AWAIT_NETWORK_IDLE}```

- `url` is the URL of the webpage to be scraped.
- `idle` is the number of milliseconds to wait for the network to be idle before saving the HTML to R2.

## Example

```curl https://{CF_Worker_Domain}/?url=https://www.example.com&idle=1000```
