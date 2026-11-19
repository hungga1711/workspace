-- Forgotten check-outs: an entry left open longer than a shift is closed as "missed check-out" the next
-- time the person checks in or out, instead of blocking both with a 409 until HR steps in. The entry keeps no hours
-- (check_out = check_in) and the flag sends the person to a correction request for that day.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS missed_checkout boolean DEFAULT false NOT NULL;

-- Installs that already hold such entries were stuck: close them the same way so everyone can check in again.
UPDATE attendance SET check_out = check_in, missed_checkout = true WHERE check_out IS NULL AND check_in < now() - interval '16 hours';
