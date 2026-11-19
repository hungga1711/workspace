-- Notifications are rendered in the reader's language when they are read, not frozen in the language their recipient
-- last used when the event happened. Each row keeps the message as a text key plus arguments (title_msg/body_msg,
-- rendered by home/texts.ts), who caused it (actor_id), a key that collapses a burst of the same thing into one
-- line (group_key, e.g. "8 approvals waiting", "Lily and 3 others commented on T-215") and small parameters for that
-- grouped line (params: the task code, the page title). title/body stay as the fallback for rows the backfill below
-- cannot rebuild. gone_at marks a notice whose task or page was deleted: it stays readable, without a link.
ALTER TABLE notifications
    ADD COLUMN title_msg jsonb,
    ADD COLUMN body_msg jsonb,
    ADD COLUMN actor_id text,
    ADD COLUMN group_key text,
    ADD COLUMN params jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN gone_at timestamp with time zone;

-- The unread line count per group, for the inbox; partial like the badge index.
CREATE INDEX notifications_group_unread_idx ON notifications USING btree (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL;
-- Deleting a task or a page tombstones the notices that point at it.
CREATE INDEX notifications_url_idx ON notifications USING btree (url);

-- Two more UI languages.
ALTER TABLE user_prefs DROP CONSTRAINT user_prefs_locale_check;
ALTER TABLE user_prefs ADD CONSTRAINT user_prefs_locale_check CHECK ((locale = ANY (ARRAY['vi'::text, 'en'::text, 'zh'::text, 'es'::text])));

-- Progress check-in notices lead nowhere (a task has no progress card): they go.
DELETE FROM notifications WHERE kind = 'task.checkin';

-- Backfill what can be rebuilt from the stored text (both languages the app wrote before).
UPDATE notifications SET title_msg = jsonb_build_object('k', 'mentioned') WHERE kind = 'mention' AND title_msg IS NULL;
UPDATE notifications SET title_msg = jsonb_build_object('k', 'aiExtension'), body_msg = jsonb_build_object('k', 'aiExtensionBody') WHERE kind = 'ai.extension' AND title_msg IS NULL;
UPDATE notifications SET title_msg = jsonb_build_object('k', 'aiPolicy') WHERE kind = 'ai.policy' AND title_msg IS NULL;
UPDATE notifications SET body_msg = jsonb_build_object('k', 'aiFlaggedBody') WHERE kind = 'ai.flagged' AND body_msg IS NULL;
UPDATE notifications SET body_msg = jsonb_build_object('k', 'quotaBody') WHERE kind = 'ai.quota' AND body_msg IS NULL;
UPDATE notifications SET title_msg = jsonb_build_object('k', 'leaveDecided', 'a', jsonb_build_array(title ~ '(đã được duyệt|was approved)'))
 WHERE kind = 'leave.decided' AND title_msg IS NULL;

-- "<prefix><title>" texts: one argument, the item's own title.
UPDATE notifications n SET title_msg = jsonb_build_object('k', m.k, 'a', jsonb_build_array(regexp_replace(n.title, m.re, '')))
  FROM (VALUES
    ('task.assigned', 'taskAssigned', '^(Bạn được giao|Assigned to you): '),
    ('task.completed', 'done', '^(Đã xong|Done): '),
    ('approval.requested', 'approvalNeeded', '^(Cần duyệt|Approval needed): '),
    ('approval.commented', 'approvalCommented', '^(Trao đổi mới về yêu cầu|New message on a request): '),
    ('decision.proposed', 'decisionNeeded', '^(Cần bạn chốt|Your decision needed): '),
    ('decision.decided', 'decided', '^(Đã chốt|Decided): '),
    ('doc.commented', 'docCommented', '^(Bình luận mới ở trang|New comment on) ')
  ) AS m(kind, k, re)
 WHERE n.kind = m.kind AND n.title_msg IS NULL AND n.title ~ m.re;
UPDATE notifications SET title_msg = jsonb_build_object('k', 'docUpdated', 'a', jsonb_build_array(regexp_replace(title, ' (vừa được cập nhật|was updated)$', '')))
 WHERE kind = 'doc.updated' AND title_msg IS NULL AND title ~ ' (vừa được cập nhật|was updated)$';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'approvalDecided',
         'a', jsonb_build_array(title ~ '^(Đã duyệt|Approved): ', regexp_replace(title, '^(Đã duyệt|Bị từ chối|Approved|Declined): ', '')))
 WHERE kind = 'approval.decided' AND title_msg IS NULL AND title ~ '^(Đã duyệt|Bị từ chối|Approved|Declined): ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'taskMention', 'a', jsonb_build_array(substring(title from '(\S+)$'))),
       params = params || jsonb_build_object('code', substring(title from '(\S+)$'))
 WHERE kind = 'task.mention' AND title_msg IS NULL AND title ~ '^(Bạn được nhắc tên trong|You were mentioned in) \S+$';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'commented', 'a', jsonb_build_array(substring(title from '^(?:Bình luận mới ở|New comment on) (\S+): '),
         regexp_replace(title, '^(Bình luận mới ở|New comment on) \S+: ', ''))),
       params = params || jsonb_build_object('code', substring(title from '^(?:Bình luận mới ở|New comment on) (\S+): '))
 WHERE kind = 'task.commented' AND title_msg IS NULL AND title ~ '^(Bình luận mới ở|New comment on) \S+: ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'leaveRequested',
         'a', jsonb_build_array(substring(title from '^(.*) (?:xin nghỉ|requested) \d+'), (substring(title from ' (\d+) (?:ngày|days? off)'))::int))
 WHERE kind = 'leave.requested' AND title_msg IS NULL AND title ~ '^.* (xin nghỉ \d+ ngày|requested \d+ days? off)$';

-- Group keys for the kinds the inbox collapses (home/notifications.ts groupKeyOf).
UPDATE notifications SET group_key = kind WHERE group_key IS NULL AND kind IN ('approval.requested', 'leave.requested', 'task.assigned', 'ai.flagged');
UPDATE notifications SET group_key = kind || ':' || ref_id WHERE group_key IS NULL AND kind IN ('task.commented', 'doc.commented') AND ref_id IS NOT NULL;
UPDATE notifications SET group_key = 'task.mention:' || substring(url from '/app/work/tasks/([^/?#]+)') WHERE group_key IS NULL AND kind = 'task.mention' AND url ~ '/app/work/tasks/';
UPDATE notifications SET group_key = 'mention:' || substring(url from '/app/chat/([^/?#]+)') WHERE group_key IS NULL AND kind = 'mention' AND url ~ '/app/chat/';
