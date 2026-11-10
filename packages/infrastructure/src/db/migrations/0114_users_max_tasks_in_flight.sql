-- migration-class: additive
-- 0114 — a person's own limit on their tasks in flight (S-28.6, the M28 ruling B on BD-010).
--
-- The owner's feedback: the platform had one limit per project on how many tasks are in the
-- pipeline, and "this should be per worker (user), each can have a separate limit, configurable".
-- `pipeline.wip.max_tasks_per_owner` (organisation: the maximum and the default; a project may
-- tighten it; 3 when nobody states one) is held per person at admission, over the tasks they own
-- (`tasks.owner_user_id`, S-26.1) that are `active`, `returned`, `waiting_answers` or
-- `waiting_approval`. This column is the person's own number:
--
--   max_tasks_in_flight   null — the default applies; otherwise 1–200, set by the person for
--                         themself or by an organisation administrator for anyone
--                         (`PUT /api/me/task-limit`, `PUT /api/org/users/:id/task-limit`), never
--                         above the organisation's value — refused at the write, and capped again
--                         at every read, so a lowered organisation value applies at once.
--
-- Additive by TD-032's list: one nullable column with no default, which the previous build never
-- names, and its range as a `not valid` check that is null-propagating by construction (every
-- existing row is null), validated at once. Its writer is the two routes above.
alter table users add column max_tasks_in_flight integer;

alter table users
  add constraint users_max_tasks_in_flight_range
  check (max_tasks_in_flight >= 1 and max_tasks_in_flight <= 200) not valid;

alter table users validate constraint users_max_tasks_in_flight_range;
