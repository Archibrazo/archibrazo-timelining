import { GET, POST } from '@/app/api/story/transcribe/route';
import { pushTranscribeFailed } from '@/services/pipeline/failed-queue';
import { runTranscribeDispatchTick } from '@/services/transcribe';
import { NextRequest } from 'next/server';

jest.mock('@/services/transcribe', () => ({
  runTranscribeDispatchTick: jest.fn(),
}));

jest.mock('@/services/pipeline/failed-queue', () => ({
  pushTranscribeFailed: jest.fn(),
}));

const mockedTick = runTranscribeDispatchTick as jest.MockedFunction<typeof runTranscribeDispatchTick>;
const mockedPushFailed = pushTranscribeFailed as jest.MockedFunction<typeof pushTranscribeFailed>;

function buildRequest(method: 'GET' | 'POST', query = '') {
  return new NextRequest(`http://localhost:3000/api/story/transcribe${query}`, {
    method,
    headers: { 'x-vercel-cron': '1' },
  });
}

describe('API /api/story/transcribe', () => {
  beforeEach(() => {
    mockedTick.mockReset();
    mockedPushFailed.mockReset();
  });

  it('runs transcribe dispatch tick on cron GET', async () => {
    mockedTick.mockResolvedValue({
      status: 'success',
      nodeKind: 'resource',
      nodeId: 'resource-1',
      jobId: 'job-1',
      dispatched: 1,
      failed: 0,
      outstanding: 20,
      schedule: '30s',
    });

    const res = await GET(buildRequest('GET'));
    expect(res.status).toBe(200);
    expect(mockedTick).toHaveBeenCalledWith(undefined);
  });

  it('dispatches for a specific resourceId', async () => {
    mockedTick.mockResolvedValue({
      status: 'success',
      nodeKind: 'resource',
      nodeId: 'resource-1',
      jobId: 'job-1',
      dispatched: 1,
      failed: 0,
      outstanding: 0,
      schedule: '15min',
    });

    const res = await POST(buildRequest('POST', '?resourceId=resource-1'));
    expect(res.status).toBe(200);
    expect(mockedTick).toHaveBeenCalledWith({ nodeKind: 'resource', nodeId: 'resource-1' });
  });

  it('dispatches for a specific entryId', async () => {
    mockedTick.mockResolvedValue({
      status: 'success',
      nodeKind: 'resource',
      nodeId: 'resource-1',
      jobId: 'job-1',
      dispatched: 1,
      failed: 0,
      outstanding: 0,
      schedule: '15min',
    });

    const res = await POST(buildRequest('POST', '?entryId=entry-1'));
    expect(res.status).toBe(200);
    expect(mockedTick).toHaveBeenCalledWith({ entryId: 'entry-1' });
  });

  it('queues failed dispatch to transcribe failed queue', async () => {
    mockedTick.mockResolvedValue({
      status: 'dispatch_failed',
      nodeKind: 'resource',
      nodeId: 'resource-1',
      dispatchError: 'http_502',
      dispatched: 0,
      failed: 1,
      outstanding: 21,
      schedule: '30s',
    });

    const res = await POST(buildRequest('POST'));
    expect(res.status).toBe(200);
    expect(mockedPushFailed).toHaveBeenCalledWith('resource-1', 'http_502');
  });
});
