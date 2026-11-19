-- Search by kind without walking the messages.
--
-- "All" asks each kind for its own top hits (chat's search endpoint). For a common word ("billing" matches tens of
-- thousands of loadtest messages) every kind's call paid for the message-sized probe in search_candidates() and then
-- filtered by kind, ~0.25 s each. Non-message documents are a few hundred rows: a partial GIN index on them and an
-- early branch answer those kinds from that index alone. Same rows and order as before, so ranking and cursors agree.

SET LOCAL check_function_bodies = false;

CREATE INDEX IF NOT EXISTS search_documents_tsv_nonmessage_idx ON search_documents USING gin (tsv) WHERE entity_type <> 'message';

CREATE OR REPLACE FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) RETURNS TABLE(entity_type text, entity_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  recent CONSTANT integer := 20000;
  common CONSTANT integer := 5000;
  n integer := least(greatest(lim, 1), 5000);
  found integer;
  newest_first boolean := false;
BEGIN
  -- Only non-message kinds asked: the partial index holds every candidate (the literal predicate lets the planner use it).
  IF types IS NOT NULL AND NOT ('message' = ANY (types)) THEN
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM search_documents d
       WHERE d.entity_type <> 'message' AND d.tsv @@ q
         AND d.entity_type = ANY (types)
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
       ORDER BY d.updated_at DESC
       LIMIT n;
    RETURN;
  END IF;
  SELECT count(*) INTO found FROM (SELECT 1 FROM search_documents d WHERE d.tsv @@ q LIMIT common) x;
  IF found >= common THEN
    SELECT count(*) >= n INTO newest_first FROM (
      SELECT 1 FROM (SELECT d.* FROM search_documents d ORDER BY d.updated_at DESC LIMIT recent) d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       LIMIT n) x;
  END IF;
  IF newest_first THEN
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM (SELECT d.* FROM search_documents d ORDER BY d.updated_at DESC LIMIT recent) d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  ELSIF found < common THEN
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM (SELECT d.* FROM search_documents d WHERE d.tsv @@ q LIMIT common) d
       WHERE (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  ELSE
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM search_documents d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  END IF;
END
$$;

ALTER FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) OWNER TO workspace_maintenance;
