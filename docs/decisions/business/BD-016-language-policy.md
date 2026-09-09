# BD-016 — English in repo, prompts and UI; agents reply to humans in the human's language

- **Status:** accepted (2026-08-28, Q9)
- **Date:** 2026-08-28

## Decision
All repository content, default prompts, knowledge base templates and UI strings are English. Agents write ticket comments, MR descriptions and Slack messages in the language of the ticket/thread (project setting `communication_language: auto | <code>`). Code, commit messages and MR titles follow the project's convention from the KB (default English).

## Rationale
Open-source audience is international; the founder's teams write tickets in Czech and English mixed; matching the human's language lowers friction.

## Consequences
- Knowledge base content can be in any language; the Librarian keeps each document single-language.
