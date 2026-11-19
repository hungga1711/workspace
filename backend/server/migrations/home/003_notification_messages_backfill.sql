-- More of the stored notification texts rebuilt as messages (002 covered the common kinds): due-soon reminders,
-- personal reminders, meeting invitations and agent questions, from the Vietnamese or English text written before.
UPDATE notifications SET title_msg = jsonb_build_object('k', 'dueSoon',
         'a', jsonb_build_array(substring(title from '^(?:Sắp đến hạn|Due soon) \(([^)]*)\): '), regexp_replace(title, '^(Sắp đến hạn|Due soon) \([^)]*\): ', '')))
 WHERE kind = 'task.due' AND title_msg IS NULL AND title ~ '^(Sắp đến hạn|Due soon) \([^)]*\): ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'reminder', 'a', jsonb_build_array(regexp_replace(title, '^(Nhắc bạn|Reminder): ', '')))
 WHERE kind = 'reminder' AND title_msg IS NULL AND title ~ '^(Nhắc bạn|Reminder): ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'meeting', 'a', jsonb_build_array(false, NULL, regexp_replace(title, '^(Lời mời họp|Meeting invitation): ', '')))
 WHERE kind = 'meeting.invited' AND title_msg IS NULL AND title ~ '^(Lời mời họp|Meeting invitation): ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'meeting', 'a', jsonb_build_array(true, NULL, regexp_replace(title, '^(Cuộc họp thay đổi|Meeting changed): ', '')))
 WHERE kind = 'meeting.updated' AND title_msg IS NULL AND title ~ '^(Cuộc họp thay đổi|Meeting changed): ';
UPDATE notifications SET title_msg = jsonb_build_object('k', 'agentAsked',
         'a', jsonb_build_array(substring(title from '^(?:AI đang hỏi ở|The AI is asking on) (\S+): '), coalesce((substring(title from ': (\d+) '))::int, 1)))
 WHERE kind = 'task.agent_ask' AND title_msg IS NULL AND title ~ '^(AI đang hỏi ở|The AI is asking on) \S+: ';
