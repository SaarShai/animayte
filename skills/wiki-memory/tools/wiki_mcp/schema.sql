-- Create main pages table
CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    body TEXT NOT NULL
);

-- Create FTS5 virtual table with external content
CREATE VIRTUAL TABLE pages_fts USING fts5(
    path, 
    frontmatter_json, 
    body,
    content='pages',
    content_rowid='id',
    tokenize=unicode61 'case-fold'
);

-- Trigger for inserting into FTS table
CREATE TRIGGER pages_insert AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, path, frontmatter_json, body)
    SELECT new.rowid, new.path, new.frontmatter_json, new.body;
END;

-- Trigger for updating FTS table
CREATE TRIGGER pages_update AFTER UPDATE ON pages BEGIN
    -- Check if any of the indexed columns have changed
    IF (OLD.path != NEW.path OR 
        OLD.frontmatter_json != NEW.frontmatter_json OR 
        OLD.body != NEW.body) THEN
        -- Update FTS content
        INSERT INTO pages_fts(rowid, path, frontmatter_json, body)
        SELECT NEW.rowid, NEW.path, NEW.frontmatter_json, NEW.body;
    END IF;
END;

-- Trigger for deleting from FTS table
CREATE TRIGGER pages_delete AFTER DELETE ON pages BEGIN
    -- Remove corresponding FTS entry
    INSERT INTO pages_fts(pages_fts, rowid) VALUES('delete', OLD.rowid);
END;
