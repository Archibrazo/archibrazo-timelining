import { logger } from '@/lib/logger';
import { isNeo4jAvailable } from '@/lib/db/neo4j';
import type { ScheduleHint } from '@/services/vectorise/shared/types';
import {
  countAwaitingTranscribe,
  loadPendingResourceIdForEntry,
  pickResourceIdsByStatus,
} from '@/services/vectorise/resource/neo4j';
import { countPipelineByStatus as countVoicePipelineByStatus, pickVoiceIdsByStatus } from '@/services/vectorise/voice/neo4j';
import { dispatchTranscribeForNode } from './dispatchStage';
import type { TranscribeDispatchTickResult, TranscribableNodeKind } from './types';

async function countOutstanding(): Promise<number> {
  const [voicePending, resourcePending] = await Promise.all([
    countVoicePipelineByStatus().then((counts) => counts.pending),
    countAwaitingTranscribe(),
  ]);
  return voicePending + resourcePending;
}

async function pickPendingNode(): Promise<{ nodeKind: TranscribableNodeKind; nodeId: string } | null> {
  const pendingVoiceIds = await pickVoiceIdsByStatus('pending', 1);
  if (pendingVoiceIds.length > 0) {
    return { nodeKind: 'voice', nodeId: pendingVoiceIds[0] };
  }

  const pendingResourceIds = await pickResourceIdsByStatus('pending', 1);
  if (pendingResourceIds.length > 0) {
    return { nodeKind: 'resource', nodeId: pendingResourceIds[0] };
  }

  return null;
}

export async function runTranscribeDispatchTick(options?: {
  nodeKind?: TranscribableNodeKind;
  nodeId?: string;
  entryId?: string;
}): Promise<TranscribeDispatchTickResult> {
  const neo4jReady = await isNeo4jAvailable();
  if (!neo4jReady) {
    logger.warn('Neo4j not available. Skipping transcribe dispatch tick.');
    return {
      status: 'skipped',
      message: 'Neo4j not configured.',
      dispatched: 0,
      failed: 0,
      outstanding: 0,
      schedule: '15min',
    };
  }

  try {
    let target: { nodeKind: TranscribableNodeKind; nodeId: string } | null = null;

    if (options?.entryId) {
      const resourceId = await loadPendingResourceIdForEntry(options.entryId);
      if (resourceId) {
        target = { nodeKind: 'resource', nodeId: resourceId };
      } else {
        return {
          status: 'idle',
          message: 'no_pending_resource_for_entry',
          dispatched: 0,
          failed: 0,
          outstanding: await countOutstanding(),
          schedule: '15min',
        };
      }
    } else if (options?.nodeKind && options.nodeId) {
      target = { nodeKind: options.nodeKind, nodeId: options.nodeId };
    } else {
      target = await pickPendingNode();
    }

    if (!target) {
      return {
        status: 'idle',
        dispatched: 0,
        failed: 0,
        outstanding: await countOutstanding(),
        schedule: '15min',
      };
    }

    const result = await dispatchTranscribeForNode(target.nodeKind, target.nodeId);
    const outstanding = await countOutstanding();
    const schedule: ScheduleHint = outstanding > 0 ? '30s' : '15min';

    if (result.status === 'not_found') {
      return {
        status: 'error',
        message: `${result.nodeKind} not found`,
        nodeKind: result.nodeKind,
        nodeId: result.nodeId,
        dispatched: 0,
        failed: 1,
        outstanding,
        schedule,
      };
    }

    if (result.status === 'dispatch_failed') {
      return {
        status: 'dispatch_failed',
        nodeKind: result.nodeKind,
        nodeId: result.nodeId,
        dispatchError: result.error,
        dispatched: 0,
        failed: 1,
        outstanding,
        schedule,
      };
    }

    logger.info('Transcribe dispatch tick complete', {
      nodeKind: result.nodeKind,
      nodeId: result.nodeId,
      jobId: result.jobId,
      outstanding,
    });

    return {
      status: 'success',
      nodeKind: result.nodeKind,
      nodeId: result.nodeId,
      jobId: result.jobId,
      dispatched: 1,
      failed: 0,
      outstanding,
      schedule,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    logger.error('Transcribe dispatch tick failed', { error: message });
    return {
      status: 'error',
      message,
      dispatched: 0,
      failed: 1,
      outstanding: await countOutstanding().catch(() => 0),
      schedule: '15min',
    };
  }
}
