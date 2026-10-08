/**
 * The **refusing stub** of the TaskManagement contract (WP-171 ruling (c)): a provider that
 * implements none of the six lifecycle members, built the way BD-017 says such a provider must be —
 * its four lifecycle flags `false`, and each member throwing `IntegrationUnsupportedError`
 * (`unsupported_capability`) **naming the member**.
 *
 * The shared suite runs against it in `test/contract/integrations/task-management.contract.test.ts`,
 * so the refusal branch is exercised on every `verify` and not only on whichever real adapter
 * happens to lack a member today. Everything else is the wrapped port's, unchanged, so the rest of
 * the suite is the wrapped provider's own result.
 *
 * `answerInsteadOfRefusing` builds the canary: the same stub, except one member answers a value
 * instead of refusing — the silent no-op the refusal branch exists to catch.
 */
import {
  IntegrationUnsupportedError,
  type LifecycleMember,
  type TaskManagementCapabilities,
  type TaskManagementPort,
} from '@platform/application';

const STUB_PROVIDER = 'refusing-stub';

const refuse = (member: LifecycleMember) => async (): Promise<never> => {
  throw new IntegrationUnsupportedError(STUB_PROVIDER, member);
};

const NO_LIFECYCLE: Pick<
  TaskManagementCapabilities,
  'lifecycleStatuses' | 'transitionsRead' | 'assign' | 'commentsRead'
> = { lifecycleStatuses: false, transitionsRead: false, assign: false, commentsRead: false };

export const refusingLifecycleStub = (
  port: TaskManagementPort,
  options: {
    /** Canary only: these members answer the given value instead of refusing. */
    readonly answerInsteadOfRefusing?: Partial<Record<LifecycleMember, unknown>>;
    /** Canary only: declare the lifecycle flags `true` while the members still misbehave. */
    readonly declareLifecycle?: boolean;
  } = {},
): TaskManagementPort => {
  const member = (name: LifecycleMember) => {
    const answers = options.answerInsteadOfRefusing ?? {};
    if (Object.hasOwn(answers, name)) {
      const value = answers[name];
      return async () => value;
    }
    return refuse(name);
  };
  return {
    ...port,
    capabilities: () => ({
      ...port.capabilities(),
      ...(options.declareLifecycle === true
        ? {
            lifecycleStatuses: true,
            transitionsRead: true,
            assign: true,
            commentsRead: true,
          }
        : NO_LIFECYCLE),
    }),
    listStatuses: member('listStatuses') as TaskManagementPort['listStatuses'],
    listTransitions: member('listTransitions') as TaskManagementPort['listTransitions'],
    selfIdentity: member('selfIdentity') as TaskManagementPort['selfIdentity'],
    assignToSelf: member('assignToSelf') as TaskManagementPort['assignToSelf'],
    unassign: member('unassign') as TaskManagementPort['unassign'],
    listComments: member('listComments') as TaskManagementPort['listComments'],
  };
};
