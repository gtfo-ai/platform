/**
 * One `Idempotency-Key` per **intent**, not per request — PROGRESS backlog 53.
 *
 * `api/http.ts` minted a fresh `crypto.randomUUID()` inside `send`, once per request, under a
 * docblock saying the key exists *"so a retry is not a second task"*. Nothing in the client held a
 * key across a retry, so a double-click, a mutation retry or a user pressing the button again after
 * a timed-out response each sent a **different** key and the server — which has answered a replay
 * from the key since WP-21 and WP-15i — was never given one to answer. The server side was honest;
 * the client never exercised it.
 *
 * ## What an "intent" is here, and why it is keyed by the variables
 *
 * A user's intent is *"create this project"*, not *"this click"*. Two sends of the same intent are
 * the same request and must carry the same key; a **new** intent — the user edits the form and
 * submits again — must carry a new one, because the same key with a different body is refused
 * `409 idempotency_key_reused` and that refusal would be exactly wrong for a corrected form.
 *
 * So a key is held per **canonical value of the variables**, minted on the first send and released
 * when that intent **succeeds**: a retry of a failed send keeps the key, a corrected form gets a
 * new one because its variables differ, and a deliberate second identical create after a success
 * gets a new one because the first released it. Three behaviours out of one rule.
 *
 * ## What it does not do
 *
 * It does not deduplicate on the client. Two clicks still send two requests; what the second one
 * carries is a key the server recognises, which is where the decision belongs — the client cannot
 * know whether the first request reached the server. And it holds keys in a `ref`, so a component
 * that unmounts between the two sends starts a new intent; that is the same window a page reload
 * has and is the reason the *server* is the thing that refuses, not this.
 */
import { useRef } from 'react';

/** Stable JSON: two identical intents whose keys were built in a different order must agree. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export interface IntentKeys {
  /** The key for this intent, minted on first use and stable until {@link release}. */
  keyFor(variables: unknown): string;
  /** This intent succeeded; the next send of the same variables is a new intent. */
  release(variables: unknown): void;
}

/** The key factory, injected so a test can assert *which* key was sent rather than only that one was. */
export type MintKey = () => string;

const defaultMint: MintKey = () => crypto.randomUUID();

export const createIntentKeys = (mint: MintKey = defaultMint): IntentKeys => {
  const held = new Map<string, string>();
  return {
    keyFor: (variables) => {
      const intent = canonicalJson(variables);
      const existing = held.get(intent);
      if (existing !== undefined) {
        return existing;
      }
      const minted = mint();
      held.set(intent, minted);
      return minted;
    },
    release: (variables) => {
      held.delete(canonicalJson(variables));
    },
  };
};

/**
 * The hook a screen's mutations share.
 *
 * One register per component instance rather than one per mutation, so a screen that submits the
 * same form twice is one intent whichever mutation carries it, and a component that unmounts drops
 * its keys with itself.
 */
export const useIntentKeys = (mint?: MintKey): IntentKeys => {
  const ref = useRef<IntentKeys | null>(null);
  if (ref.current === null) {
    ref.current = createIntentKeys(mint);
  }
  return ref.current;
};
