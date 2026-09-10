/**
 * The SDK `sessionStore` mirror (technical/04's `sessionStore`, `sessionStoreFlush: 'eager'`).
 *
 * TD-007 is explicit about what this is **not**: "The platform's own stream consumer (**not** the
 * SDK `sessionStore` mirror) writes every completed SDK message as a row … The SDK `sessionStore`
 * is *additionally* used for cross-host resume (best-effort mirror)." So `run_messages` is the
 * transcript, and this is the file `claude --resume` needs to exist on whichever host picks the run
 * up after a restart (technical/04 § "Resume and take-over").
 *
 * **The mirror is not redacted, on purpose — filed as Q40 in `docs/OPEN-QUESTIONS.md`.** TD-012 enumerates the write paths redaction
 * applies to (`run_messages`, `integration_actions`, `events.payload`, `config_audit`, artifacts, KB
 * commits) and the session mirror is not among them. It cannot be: the mirror's only consumer is
 * `resume`, which replays it into the model's context, and a resumed run whose own earlier tool
 * output has become `[REDACTED sha256:…]` has had its memory corrupted rather than protected. The
 * mirror is therefore treated as credential-bearing storage — same database, same access control,
 * never rendered to a human and never published on an event — and the question is filed rather
 * than decided quietly.
 *
 * Failures are the adapter's own problem, not the run's: the SDK retries an `append` three times
 * and then emits a `mirror_error` system message and carries on (verified in the `SessionStore`
 * declaration). That message is normalised into the transcript like any other, so a broken mirror
 * is visible without being fatal.
 */
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMirrorKey, SessionMirrorPort } from '@platform/application';
import type { JsonObject } from '@platform/contracts';

const toKey = (key: SessionKey): SessionMirrorKey =>
  key.subpath === undefined
    ? { projectKey: key.projectKey, sessionId: key.sessionId }
    : { projectKey: key.projectKey, sessionId: key.sessionId, subpath: key.subpath };

export const toSdkSessionStore = (port: SessionMirrorPort): SessionStore => {
  const store: SessionStore = {
    append: async (key, entries) => {
      await port.append(toKey(key), entries as unknown as JsonObject[]);
    },
    load: async (key) => {
      const entries = await port.load(toKey(key));
      return entries === null ? null : (entries as unknown as SessionStoreEntry[]);
    },
  };
  const listSubkeys = port.listSubkeys;
  if (listSubkeys !== undefined) {
    store.listSubkeys = async (key) =>
      listSubkeys.call(port, { projectKey: key.projectKey, sessionId: key.sessionId });
  }
  return store;
};

/**
 * A note on `SessionKey.projectKey`, which the platform does **not** choose.
 *
 * The installed SDK derives it from the sanitised `cwd` and exposes no option to set it (searched:
 * `projectKey` appears in `SessionStore` and `SessionKey` only, never in `Options`). So the key a
 * mirror is filed under is a function of the workspace path — which is exactly why technical/04
 * pins `CLAUDE_CODE_PROJECT_DIR_NAME=<task-id>` and why WP-14 must give a task the same workspace
 * path on every host: a resume that looks under a different `projectKey` finds nothing and starts
 * a fresh session instead of continuing the interrupted one, silently.
 */
export const PROJECT_KEY_IS_DERIVED_FROM_CWD = true;
