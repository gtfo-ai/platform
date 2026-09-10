/**
 * One SSE connection per tab, shared by every screen (TD-014).
 *
 * Screens do not open streams; they *retain* topics. `useTopics(['task:…'])` adds the topic while
 * the component is mounted and releases it when it unmounts, and the provider keeps a reference
 * count so two screens watching the same task do not fight over it. The union is handed to
 * `RealtimeClient.setTopics`, which either updates the subscription over
 * `POST /events/subscriptions` or reopens the stream.
 *
 * A `reset` and every domain event go straight to the Query bridge; transcript frames go to the
 * transcript store. Neither is a React state update, which is the point: a run emitting 40 frames
 * a second must not re-render the tree 40 times.
 */
import type { SseTopic } from '@platform/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TranscriptStore } from '../transcript/store.js';
import {
  createRealtimeClient,
  type EventStreamFactory,
  type RealtimeClient,
  type RealtimeStatus,
} from './client.js';
import { createQueryBridge } from './query-bridge.js';

export interface RealtimeContextValue {
  readonly status: RealtimeStatus;
  readonly retain: (topics: readonly SseTopic[]) => () => void;
  readonly client: RealtimeClient;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const browserEventStream: EventStreamFactory = (url) =>
  new EventSource(url, { withCredentials: true });

export interface RealtimeProviderProps {
  readonly children: ReactNode;
  readonly transcripts: TranscriptStore;
  /** Injected in tests; the browser's `EventSource` in production. */
  readonly openStream?: EventStreamFactory;
  /** `POST /events/subscriptions`, injected for the same reason. */
  readonly updateSubscriptions?: (body: {
    readonly connection_id: string;
    readonly add?: readonly SseTopic[];
    readonly remove?: readonly SseTopic[];
  }) => Promise<void>;
  /** When false the provider is inert: used by unit tests that render a screen in isolation. */
  readonly enabled?: boolean;
}

export const RealtimeProvider = ({
  children,
  transcripts,
  openStream,
  updateSubscriptions,
  enabled = true,
}: RealtimeProviderProps): ReactElement => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const counts = useRef(new Map<SseTopic, number>());

  const client = useMemo(() => {
    const bridge = createQueryBridge({
      queryClient,
      onTranscript: (frame) => {
        transcripts.apply(frame.data);
      },
    });
    return createRealtimeClient({
      openStream: openStream ?? browserEventStream,
      ...(updateSubscriptions === undefined ? {} : { updateSubscriptions }),
      onFrame: bridge.onFrame,
      onReset: bridge.onReset,
      onStatus: setStatus,
    });
  }, [queryClient, transcripts, openStream, updateSubscriptions]);

  useEffect(
    () => () => {
      client.close();
    },
    [client],
  );

  /**
   * **`retain` must not change identity when the status does.**
   *
   * `useTopics` holds it as an effect dependency, so a `retain` that were rebuilt on every status
   * change would make every screen release and re-acquire its topics each time the badge moved —
   * and a release that empties the topic set followed by a re-acquire is a *reconnect*. That
   * turned an `event: shutdown` into an immediate reopen: the status went `server_shutdown`,
   * React re-rendered, the effect churned, and the client reconnected instantly instead of on its
   * backoff. Found by `test/web-e2e/realtime.spec.ts`, which could never observe the state the
   * server had just announced.
   */
  const retain = useCallback(
    (topics: readonly SseTopic[]) => {
      const publish = (): void => {
        if (!enabled) {
          return;
        }
        client.setTopics([...counts.current.keys()]);
      };
      for (const topic of topics) {
        counts.current.set(topic, (counts.current.get(topic) ?? 0) + 1);
      }
      publish();
      return () => {
        for (const topic of topics) {
          const next = (counts.current.get(topic) ?? 1) - 1;
          if (next <= 0) {
            counts.current.delete(topic);
          } else {
            counts.current.set(topic, next);
          }
        }
        publish();
      };
    },
    [client, enabled],
  );

  const value = useMemo<RealtimeContextValue>(
    () => ({ status, client, retain }),
    [client, status, retain],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
};

export const useRealtime = (): RealtimeContextValue => {
  const value = useContext(RealtimeContext);
  if (value === null) {
    throw new Error('useRealtime was called outside <RealtimeProvider>');
  }
  return value;
};

/** Watches these topics for as long as the calling component is mounted. */
export const useTopics = (topics: readonly SseTopic[]): void => {
  const { retain } = useRealtime();
  // The array identity changes on every render; its contents do not. Joining is what makes the
  // effect depend on the topics rather than on the array that carries them.
  const key = topics.join(',');
  useEffect(() => {
    if (key === '') {
      return;
    }
    return retain(key.split(',') as SseTopic[]);
  }, [key, retain]);
};
