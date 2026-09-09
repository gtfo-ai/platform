/**
 * The Communication contract against the in-memory fake (technical/10 contract tier).
 *
 * WP-10 adds a second runner for Slack (Socket Mode) against the same suite.
 */
import { createFakeCommunication } from '@platform/integrations';
import {
  type CommunicationContractContext,
  runCommunicationContract,
} from '../support/integrations/communication-contract-suite.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a3';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b3';
const TASK_ID = '00000000-0000-4000-8000-0000000000c3';
const QUESTION_ID = '00000000-0000-4000-8000-0000000000d3';
const APPROVAL_ID = '00000000-0000-4000-8000-0000000000e3';

runCommunicationContract({
  name: 'in-memory fake',
  create: async (): Promise<CommunicationContractContext> => {
    const port = createFakeCommunication({
      integrationId: INTEGRATION_ID,
      channels: ['#agentic'],
      identities: [
        { providerUserId: 'U-MAPPED', email: 'dev@example.test', displayName: 'Dev One' },
      ],
    });

    return {
      port,
      channel: '#agentic',
      missingChannel: '#does-not-exist',
      taskId: TASK_ID,
      questionId: QUESTION_ID,
      approvalId: APPROVAL_ID,
      mappedAuthor: { providerUserId: 'U-MAPPED', email: 'dev@example.test' },
      unmappedAuthorId: 'U-STRANGER',
      emitAnswer: (authorId, text) =>
        port.emitAnswer({ taskId: TASK_ID, questionId: QUESTION_ID, authorId, text }),
      emitApproval: (authorId, decision) =>
        port.emitApproval({ taskId: TASK_ID, approvalId: APPROVAL_ID, authorId, decision }),
      emitFeedback: (authorId, text) => port.emitFeedback({ taskId: TASK_ID, authorId, text }),
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      cleanup: async () => {},
    };
  },
});
