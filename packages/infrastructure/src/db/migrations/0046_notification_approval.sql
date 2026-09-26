-- 0046 — an approval is a notification class (WP-43, PROGRESS backlog 78).
--
-- WP-32 built the notification band and deliberately left `task.approval.requested` out of it: an
-- approval posted to a chat channel is a message with two buttons, and this build opened no Socket
-- Mode connection, so a button would have been a control that did nothing. WP-43 opens the socket in
-- the process that serves `/webhooks/*` and routes a click through the Approval aggregate, so the
-- request is announced now — with buttons when the binding can receive a click, as a message that
-- says to decide on the task page when it cannot.
--
-- It is a **class** rather than a message posted beside the band, because the band is where quiet
-- hours and the digest live (product/18): an approval raised at night is held for the morning like
-- a question, and an operator who wants it immediate lists `approval` among the urgent classes. The
-- digest line it becomes carries no button — by morning the task page is the place to decide — which
-- is the honest rendering of a click that would arrive hours after the message was written.
--
-- Only the check changes. The column is `text`, the unique key is unchanged, and every existing row
-- satisfies the wider set.
alter table notifications drop constraint notifications_class_known;

alter table notifications add constraint notifications_class_known check (
  class in (
    'task_started',
    'question',
    'stage_returned',
    'escalation',
    'task_completed',
    'task_cancelled',
    'budget_threshold',
    'budget_exhausted',
    'approval'
  )
);
