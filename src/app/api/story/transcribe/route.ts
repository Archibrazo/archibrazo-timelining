import { logger } from '@/lib/logger';
import { verifyCronOrInfraRequest } from '@/lib/private-auth';
import { pushTranscribeFailed } from '@/services/pipeline/failed-queue';
import { runTranscribeDispatchTick } from '@/services/transcribe';
import type { TranscribableNodeKind } from '@/services/transcribe';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

function parseNodeKind(value: string | null): TranscribableNodeKind | undefined {
  if (value === 'voice' || value === 'resource') {
    return value;
  }
  return undefined;
}

async function handleTranscribe(request: NextRequest) {
  const authError = verifyCronOrInfraRequest(request);
  if (authError) {
    return authError;
  }

  const voiceId = request.nextUrl.searchParams.get('voiceId');
  const resourceId = request.nextUrl.searchParams.get('resourceId');
  const entryId = request.nextUrl.searchParams.get('entryId');
  const nodeKindParam = parseNodeKind(request.nextUrl.searchParams.get('nodeKind'));
  const nodeIdParam = request.nextUrl.searchParams.get('nodeId');

  logger.info('Transcribe dispatch triggered.', {
    method: request.method,
    voiceId,
    resourceId,
    entryId,
    nodeKind: nodeKindParam,
    nodeId: nodeIdParam,
  });

  try {
    const options =
      entryId != null
        ? { entryId }
        : voiceId != null
          ? { nodeKind: 'voice' as const, nodeId: voiceId }
          : resourceId != null
            ? { nodeKind: 'resource' as const, nodeId: resourceId }
            : nodeKindParam && nodeIdParam
              ? { nodeKind: nodeKindParam, nodeId: nodeIdParam }
              : undefined;

    const result = await runTranscribeDispatchTick(options);

    if (result.status === 'dispatch_failed' && result.nodeId) {
      await pushTranscribeFailed(result.nodeId, result.dispatchError ?? 'dispatch_failed');
    }

    return NextResponse.json({ status: 'Transcribe dispatch executed', result }, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ error: 'Unknown error occurred' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleTranscribe(request);
}

export async function POST(request: NextRequest) {
  return handleTranscribe(request);
}
