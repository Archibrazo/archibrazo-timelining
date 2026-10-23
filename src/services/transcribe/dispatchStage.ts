import { logger } from '@/lib/logger';
import { dispatchTranscribeJob } from '@/lib/transcribe/dispatch';
import type { TranscribeJob } from '@/lib/transcribe/types';
import { loadResourceById } from '@/services/vectorise/resource/neo4j';
import { loadVoiceById } from '@/services/vectorise/voice/neo4j';
import type { TranscribableNodeKind } from './types';

export type TranscribeDispatchStageResult =
  | { status: 'dispatched'; nodeKind: TranscribableNodeKind; nodeId: string; jobId: string }
  | { status: 'not_found'; nodeKind: TranscribableNodeKind; nodeId: string }
  | { status: 'dispatch_failed'; nodeKind: TranscribableNodeKind; nodeId: string; error: string };

async function buildVoiceJob(voiceId: string): Promise<TranscribeJob | null> {
  const voice = await loadVoiceById(voiceId);
  if (!voice) {
    return null;
  }

  return {
    sourceKind: 'telegram_voice',
    nodeId: voiceId,
    telegramFileId: voice.fileId,
  };
}

async function buildResourceJob(resourceId: string): Promise<TranscribeJob | null> {
  const resource = await loadResourceById(resourceId);
  if (!resource?.youtubeVideoId) {
    return null;
  }

  return {
    sourceKind: 'youtube',
    nodeId: resourceId,
    youtubeVideoId: resource.youtubeVideoId,
  };
}

export async function dispatchTranscribeForNode(
  nodeKind: TranscribableNodeKind,
  nodeId: string
): Promise<TranscribeDispatchStageResult> {
  const job =
    nodeKind === 'voice' ? await buildVoiceJob(nodeId) : await buildResourceJob(nodeId);

  if (!job) {
    return { status: 'not_found', nodeKind, nodeId };
  }

  const dispatch = await dispatchTranscribeJob(job);
  if (!dispatch.dispatched) {
    logger.warn('Transcribe dispatch failed', {
      nodeKind,
      nodeId,
      error: dispatch.error,
    });
    return {
      status: 'dispatch_failed',
      nodeKind,
      nodeId,
      error: dispatch.error ?? 'dispatch_failed',
    };
  }

  logger.info('Transcribe job dispatched', {
    nodeKind,
    nodeId,
    jobId: dispatch.jobId,
    sourceKind: job.sourceKind,
  });

  return {
    status: 'dispatched',
    nodeKind,
    nodeId,
    jobId: dispatch.jobId!,
  };
}
