import { POST } from '@/app/api/story/transcription/resource/route';
import { chainResourceVectorise } from '@/services/vectorise/resource/chain';
import {
  markResourceTranscribed,
  recordStageFailure,
} from '@/services/vectorise/resource/neo4j';
import { NextRequest } from 'next/server';

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (callback: () => void) => callback(),
}));

jest.mock('@/services/vectorise/resource/neo4j', () => ({
  markResourceTranscribed: jest.fn(),
  recordStageFailure: jest.fn(),
}));

jest.mock('@/services/vectorise/resource/chain', () => ({
  chainResourceVectorise: jest.fn(),
  buildResourceChunkChainPath: jest.fn((id: string) => `/chunk/${id}`),
}));

const mockedMark = markResourceTranscribed as jest.MockedFunction<typeof markResourceTranscribed>;
const mockedFailure = recordStageFailure as jest.MockedFunction<typeof recordStageFailure>;
const mockedChain = chainResourceVectorise as jest.MockedFunction<typeof chainResourceVectorise>;

function buildRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/story/transcription/resource', {
    method: 'POST',
    headers: {
      'x-vercel-cron': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('API /api/story/transcription/resource', () => {
  beforeEach(() => {
    mockedMark.mockReset();
    mockedFailure.mockReset();
    mockedChain.mockReset();
    mockedMark.mockResolvedValue(true);
  });

  it('marks resource transcribed on completed callback', async () => {
    const res = await POST(
      buildRequest({
        jobId: 'job-1',
        sourceKind: 'youtube',
        nodeId: 'resource-1',
        status: 'completed',
        transcription: 'hello world',
        transcriptSource: 'whisper',
      })
    );

    expect(res.status).toBe(200);
    expect(mockedMark).toHaveBeenCalledWith('resource-1', 'hello world');
    expect(mockedChain).toHaveBeenCalled();
  });

  it('records stage failure on failed callback', async () => {
    const res = await POST(
      buildRequest({
        jobId: 'job-1',
        sourceKind: 'youtube',
        nodeId: 'resource-1',
        status: 'failed',
        transcriptSource: 'whisper',
        error: 'download failed',
      })
    );

    expect(res.status).toBe(200);
    expect(mockedFailure).toHaveBeenCalledWith('resource-1', 'transcribe');
  });

  it('returns 404 when resource is missing', async () => {
    mockedMark.mockResolvedValue(false);

    const res = await POST(
      buildRequest({
        jobId: 'job-1',
        sourceKind: 'youtube',
        nodeId: 'missing',
        status: 'completed',
        transcription: 'hello world',
        transcriptSource: 'whisper',
      })
    );

    expect(res.status).toBe(404);
  });
});
