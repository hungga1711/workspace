-- Deleting a message (ON DELETE CASCADE) finds the saves of it by message, which the (user_id, message_id) key cannot.
CREATE INDEX IF NOT EXISTS saved_messages_message_idx ON saved_messages USING btree (message_id);
