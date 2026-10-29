import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@/lib/logger';
import { transcribeAudioFile } from '../shared/whisper';
import { MAX_VOICE_DURATION_SEC } from './types';
import {
  loadEntryTopicForVoice,
  loadVoiceById,
  markDeferredLong,
  markTranscribed,
  recordStageFailure,
} from './neo4j';
import { triggerResolve } from '@/services/resolve';

function getBotToken(): string {
  const token =
    process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development'
      ? process.env.TELEGRAM_BOT_TOKEN_DEV
      : process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('Telegram bot token not configured');
  }
  return token;
}

/**
 * GET against the Telegram Bot API with retries. Errors are rethrown without the
 * axios request config, whose URL embeds the bot token and would otherwise end up in logs.
 */
async function telegramGet(
  url: string,
  options: { params?: Record<string, string>; responseType?: 'arraybuffer'; timeout: number },
  attempts = 3
) {
  let lastMessage = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      const code = axios.isAxiosError(err) ? err.code ?? err.response?.status : undefined;
      lastMessage = `${err instanceof Error ? err.message : String(err)}${code ? ` (${code})` : ''}`;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw new Error(`Telegram request failed after ${attempts} attempts: ${lastMessage}`);
}

async function getTelegramFilePath(fileId: string): Promise<string | null> {
  const botToken = getBotToken();
  const response = await telegramGet(`https://api.telegram.org/bot${botToken}/getFile`, {
    params: { file_id: fileId },
    timeout: 8000,
  });

  if (response.data?.ok) {
    return response.data.result.file_path as string;
  }
  return null;
}

async function downloadTelegramFile(filePath: string): Promise<string> {
  const botToken = getBotToken();
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await telegramGet(url, { responseType: 'arraybuffer', timeout: 15000 }, 2);

  const ext = path.extname(filePath) || '.oga';
  const localPath = path.join(os.tmpdir(), `voice-${Date.now()}${ext}`);
  await fs.promises.writeFile(localPath, response.data);
  return localPath;
}

export type TranscribeStageResult = 'transcribed' | 'skipped_long' | 'failed' | 'not_found';

export async function transcribeStage(voiceId: string): Promise<TranscribeStageResult> {
  const voice = await loadVoiceById(voiceId);
  if (!voice) return 'not_found';

  if (voice.duration > MAX_VOICE_DURATION_SEC) {
    await markDeferredLong(voiceId);
    logger.info('Voice deferred (long duration)', { voiceId, duration: voice.duration });
    return 'skipped_long';
  }

  let localPath: string | undefined;

  try {
    const filePath = await getTelegramFilePath(voice.fileId);
    if (!filePath) {
      throw new Error(`Could not resolve Telegram file path for ${voice.fileId}`);
    }

    localPath = await downloadTelegramFile(filePath);
    const transcription = await transcribeAudioFile(localPath);

    if (!transcription.trim()) {
      throw new Error('Empty transcription returned');
    }

    await markTranscribed(voiceId, transcription);
    logger.info('Voice transcribed', { voiceId });

    const entryRef = await loadEntryTopicForVoice(voiceId);
    if (entryRef) {
      await triggerResolve(entryRef.entryId, entryRef.topic, { source: 'voice', voiceId });
    }

    return 'transcribed';
  } catch (error) {
    logger.error('Transcribe stage failed', { voiceId, error });
    await recordStageFailure(voiceId, 'transcribe');
    return 'failed';
  } finally {
    if (localPath) {
      await fs.promises.unlink(localPath).catch(() => undefined);
    }
  }
}
