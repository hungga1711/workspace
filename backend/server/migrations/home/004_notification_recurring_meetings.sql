-- Invitations to a recurring series ("Weekday meeting invitation: …", "Lời mời họp hằng tuần: …") rebuilt as messages
-- too, so they follow the reader's language like the rest (002, 003).
UPDATE notifications n SET title_msg = jsonb_build_object('k', 'meeting', 'a', jsonb_build_array(false, r.rec, regexp_replace(n.title, r.re, '')))
  FROM (VALUES
    ('daily', '^(Daily meeting invitation|Lời mời họp hằng ngày): '),
    ('weekdays', '^(Weekday meeting invitation|Lời mời họp các ngày trong tuần): '),
    ('weekly', '^(Weekly meeting invitation|Lời mời họp hằng tuần): '),
    ('biweekly', '^(Fortnightly meeting invitation|Lời mời họp 2 tuần một lần): '),
    ('monthly', '^(Monthly meeting invitation|Lời mời họp hằng tháng): ')
  ) AS r(rec, re)
 WHERE n.kind = 'meeting.invited' AND n.title_msg IS NULL AND n.title ~ r.re;
