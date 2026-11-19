-- New pages are drafts: the "+" in a space's tree and "Tạo trang" create a page at once so it can be
-- edited live, but nobody else should find an empty, untitled page in the tree before its author publishes it.
-- A draft is readable by its owner only (documents.ts canReadDoc) and may have an empty title, which the web shows
-- in the reader's own language instead of storing the author's ("Trang chưa đặt tên" seen by English readers).
ALTER TABLE documents ADD COLUMN published boolean NOT NULL DEFAULT true;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_title_check;
ALTER TABLE documents ADD CONSTRAINT documents_title_check
    CHECK (length(title) <= 300 AND (length(title) >= 1 OR NOT published));

-- Pages the old tree button left behind: still on their first, empty version and named only by the placeholder.
UPDATE documents d SET published = false, title = ''
 WHERE d.current_version = 1
   AND d.title IN ('Trang chưa đặt tên', 'Untitled page')
   AND EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id AND v.version = 1 AND btrim(v.content) IN ('', '<p></p>'));
