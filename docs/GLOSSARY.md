# Glossary (ubiquitous language)

Use these words exactly, in docs, UI and code. Add new terms here before using them.

| Term | Meaning |
|---|---|
| **Organisation** | The single tenant of an instance. Owns users, integrations, global settings, budgets, projects. |
| **Project** | One git repository bound to task-management, communication and observability integrations, with its own pipeline config, knowledge base, budgets and tasks. |
| **Integration** | A connection to an external system. Has a **type** (Task management, Git provider, Communication, Observability–logs, Observability–errors) and a **provider** (Jira, GitLab, Slack, Loki, Sentry). |
| **Binding** | The project-level configuration of an integration (which Jira project/rule, which Slack channel…). |
| **Task** | One unit of work, 1:1 with a ticket. Moves through a pipeline. |
| **Ticket** | The task's representation in the task-management integration (Jira issue). |
| **Pipeline** | The ordered, branching set of stages a task goes through. Defined by a **template**, customisable per project. |
| **Stage** | A step in the pipeline: `agent`, `gate`, `human` or `system`. |
| **Agent** | A Claude run with a **role** (Product Manager, Architect, Developer, Reviewer…), a prompt, a model, an effort, tools and limits. |
| **Role** | The job description of an agent (responsibilities, inputs, outputs, when to ask/stop). |
| **Run** | One execution of an agent stage. Carries the prompt, settings, transcript, tokens and cost. |
| **Artifact** | A structured, versioned output of a stage attached to the task (Refined Spec, Plan, RCA, Verdict, Retro Report). |
| **Return** | A backwards transition with a reason and structured feedback. |
| **Question** | A request for human input raised by a stage; pauses the task. |
| **Approval** | A human checkpoint (e.g. plan approval) required by policy. |
| **Escalation** | Parking a task in `Needs human` with a reason. |
| **Iteration** | One loop through a return cycle (e.g. code review → implementation → code review). Bounded. |
| **Event** | An immutable fact that happened (`task.stage.completed`). Handlers react to events with priorities and may emit more events. |
| **Handler** | A unit of behaviour subscribed to an event. Integrations, stages and notifications are handlers. |
| **Knowledge base (KB)** | The per-project vault of markdown documents in `.agentic/knowledge` plus its platform-side index. |
| **Context pack** | The set of KB documents and task artifacts assembled for a specific run, with the reason each was included. |
| **Rule** | A short imperative instruction always injected into agents of a scope (project/stage). Lives in `.agentic/rules`. |
| **Lesson** | A dated, sourced insight from a retrospective or feedback, stored in the KB. May be promoted to a rule. |
| **Proposal** | A suggested change to the KB awaiting approval (or auto-applied per policy). |
| **Librarian** | The agent that consolidates proposals into the KB and keeps it tidy. |
| **Onboarding** | The guided process of populating a project's KB with business and technical context. |
| **Workspace** | The isolated checkout in which an agent runs for a task. |
| **Budget** | A spend cap with a window (daily/weekly/monthly) at org, project, task or run scope. |
| **WIP limit** | Maximum parallel tasks / tasks in pipeline per project. |
| **Drift** | A refinement finding that a ticket contradicts or wanders from the documented product direction. Label only. |
| **Definition of Ready** | The refinement gate: spec complete enough that architecture can start without guessing. |
| **Fast path** | A shortened re-entry into a stage (e.g. code review after addressing findings only). |
| **Readiness** | A per-project level (0–4) computed from binary repository criteria (tests, CI, lint, setup, docs…) that drives conservative defaults and is never auto-remediated. |
| **Probation mode** | New-project state in which every plan requires approval for the first N tasks. |
| **Mapped user** | A Jira/GitLab/Slack identity matched to a platform account by email; only mapped users can answer questions or approve. |
| **Significance** | The Librarian's score for a proposed knowledge change, compared with the discard and auto-apply thresholds. |
| **Provider mode** | How Claude is accessed: `api` (API key / cloud provider) or `local` (locally available Claude Code binary and operator-supplied credentials). |
