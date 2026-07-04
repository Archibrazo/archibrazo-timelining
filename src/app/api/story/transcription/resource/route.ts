import { after } from 'next/server';
import { logger } from '@/lib/logger';
import { originFromRequest } from '@/lib/internal-dispatch';
import { verifyCronOrInfraRequest } from '@/lib/private-auth';
import type { TranscriptionCallback } from '@/lib/transcribe/types';
import {
  buildResourceChunkChainPath,
  chainResourceVectorise,
} from '@/services/vectorise/resource/chain';
import {
  markResourceTranscribed,
  recordStageFailure,
} from '@/services/vectorise/resource/neo4j';
import { NextRequest, NextResponse } from 'next/server';

function parseCallback(body: unknown): TranscriptionCallback | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const record = body as Record<string, unknown>;
  if (
    record.sourceKind !== 'youtube' ||
    typeof record.nodeId !== 'string' ||
    typeof record.jobId !== 'string' ||
    (record.status !== 'completed' && record.status !== 'failed') ||
    record.transcriptSource !== 'whisper'
  ) {
    return null;
  }

  return {
    jobId: record.jobId,
    sourceKind: 'youtube',
    nodeId: record.nodeId,
    status: record.status,
    transcription: typeof record.transcription === 'string' ? record.transcription : undefined,
    transcriptSource: 'whisper',
    language: typeof record.language === 'string' ? record.language : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

export async function POST(request: NextRequest) {
  const authError = verifyCronOrInfraRequest(request);
  if (authError) {
    return authError;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const payload = parseCallback(body);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid transcription callback payload' }, { status: 400 });
  }

  const resourceId = payload.nodeId;

  try {
    if (payload.status === 'completed') {
      const transcription = payload.transcription?.trim();
      if (!transcription) {
        return NextResponse.json({ error: 'Empty transcription' }, { status: 400 });
      }

      const updated = await markResourceTranscribed(resourceId, transcription);
      if (!updated) {
        logger.warn('Resource transcription callback: node not found', {
          resourceId,
          jobId: payload.jobId,
        });
        return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
      }

      logger.info('Resource transcription callback applied', { resourceId, jobId: payload.jobId });

      const origin = originFromRequest(request);
      after(() => chainResourceVectorise(origin, buildResourceChunkChainPath(resourceId)));

      return NextResponse.json({ status: 'ok', resourceId }, { status: 200 });
    }

    await recordStageFailure(resourceId, 'transcribe');
    logger.warn('Resource transcription callback failed', {
      resourceId,
      jobId: payload.jobId,
      error: payload.error,
    });
    return NextResponse.json({ status: 'failed', resourceId }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    logger.error('Resource transcription callback error', { resourceId, error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
