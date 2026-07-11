CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE,
  language TEXT,
  content_hash TEXT,
  loc INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  kind TEXT,
  name TEXT,
  qualified_name TEXT,
  signature TEXT,
  doc_summary TEXT,
  start_line INTEGER,
  end_line INTEGER
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  src_id INTEGER,
  src_type TEXT,
  dst_id INTEGER,
  dst_type TEXT,
  dst_name TEXT,
  edge_type TEXT,
  resolved INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type, resolved);
