-- SQLITE 
DROP TABLE IF EXISTS PageMetadata;
DROP INDEX IF EXISTS idx_url;

CREATE TABLE IF NOT EXISTS PageMetadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    r2_path TEXT NOT NULL,
    lang VARCHAR(7) NOT NULL DEFAULT 'en',
    page_crawled_at TIMESTAMP DEFAULT NULL,
    markdown_created_at TIMESTAMP DEFAULT NULL,
    embedding_created_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_url ON PageMetadata (url, r2_path);