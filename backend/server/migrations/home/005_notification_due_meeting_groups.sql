-- Due-soon notices and meeting invitations fold into one inbox line while two or more are unread
-- ("3 tasks due soon", "5 meeting invitations"), like approvals and assignments (notifications.ts groupKeyOf).
UPDATE notifications SET group_key = kind WHERE group_key IS NULL AND kind IN ('task.due', 'meeting.invited');
