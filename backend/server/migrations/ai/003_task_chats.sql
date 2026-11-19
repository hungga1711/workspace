-- "Hỏi AI về task": a person's own AI chat about one task, grounded in the task, related tasks,
-- documents and chat. docs/architecture/task-ai-chat.md.
--
-- Private to the person who asked: no admin, manager or oversight view reads these tables (unlike ai_conversations,
-- which AI Insights and the oversight pages list), which is why they are not rows of ai_conversations. Usage is still
-- metered in ai_usage with subject type 'task', so AI Insights counts it without seeing the text.
-- One active chat per (person, task) is the newest row; "Cuộc trò chuyện mới" starts another, the old ones are kept.
CREATE TABLE IF NOT EXISTS ai_task_chats (
    id text NOT NULL,
    user_id text NOT NULL,
    task_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    messages integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_task_chats_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS ai_task_chats_user_task_idx ON ai_task_chats USING btree (user_id, task_id, last_at DESC);

-- `sources`: what an answer cited ([n] in its text: task, document, message, project), shown as chips.
-- `tool_calls`: the outside (MCP) tools it used, as in ai_messages.
CREATE TABLE IF NOT EXISTS ai_task_chat_messages (
    id text NOT NULL,
    chat_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    sources jsonb,
    tool_calls jsonb,
    CONSTRAINT ai_task_chat_messages_pkey PRIMARY KEY (id),
    CONSTRAINT ai_task_chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT ai_task_chat_messages_chat_fk FOREIGN KEY (chat_id) REFERENCES ai_task_chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_task_chat_messages_chat_idx ON ai_task_chat_messages USING btree (chat_id, at);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_task_chats TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_task_chat_messages TO workspace_ai_rw;
