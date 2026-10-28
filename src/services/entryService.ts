import { getDriver, initDriver } from '../lib/db/neo4j';
import neo4j, { type QueryResult, type Transaction } from 'neo4j-driver';
import { logger } from '../lib/logger';
import { 
  FullEntryData, 
  FullEntryInputData,
 } from '@/lib/db/models/entry'; 
import { mapFullEntryData } from '@/lib/db/mappers';

export interface ExpectedEntryMap {
  [key: string]: string | number;
}

export function logNodeCreation(input: FullEntryInputData): ExpectedEntryMap {
  const logMessages: ExpectedEntryMap = {};

  // Define the keys and conditions in the logMessages object
  if (input.replyTo) logMessages['reply'] = input.replyTo.messageId;
  if (input.textContent) logMessages['textContent'] = 1;
  if (input.captionContent) logMessages['captionContent'] = 1;
  if (input.entities?.length > 0) logMessages['entities'] = input.entities.length;
  if (input.photos?.length > 0) logMessages['photos'] = 1; // Only 1 although array because we take only the last (largest) fileId
  if (input.voice) logMessages['voice'] = 1;
  if (input.videos?.length > 0) logMessages['videos'] = input.videos.length;
  if (input.videoNote) logMessages['videoNote'] = 1;
  
  // Now log all the messages at once
  if (Object.keys(logMessages).length) {
    const combinedLogMessage = 
      "Creating and linking the following optional nodes and relationships (in addition to entry, participant, and chat):" +
      Object.entries(logMessages)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
  
    logger.info(combinedLogMessage);
  }
  
  return logMessages  
}

export async function createEntry(input: FullEntryInputData): Promise<string> {
  const driver = await initDriver();
  const session = driver.session({ database: 'neo4j' })

  logger.debug(input)

  try {
    const result = await session.writeTransaction(async (tx: Transaction): Promise<QueryResult> => {
      const cypherQuery = `
        MERGE (p:Participant {handle: $senderHandle})
        MERGE (c:TelegramChat {id: $chatId, topic: $chatTopic})
        ON CREATE SET 
          c.type = $chatType,
          c.title = CASE 
            WHEN $chatType = 'supergroup' AND $chatTitle IS NOT NULL THEN $chatTitle 
            ELSE NULL 
          END,
          c.username = CASE 
            WHEN $chatType = 'private' AND $chatUsername IS NOT NULL THEN $chatUsername 
            ELSE NULL 
          END,
          c.topic = CASE 
            WHEN $chatType = 'supergroup' AND $chatTopic IS NOT NULL THEN $chatTopic 
            ELSE NULL 
          END
        WITH p, c
        OPTIONAL MATCH (existing:Entry)-[:FROM_CHAT]->(c)
        WHERE toInteger(existing.messageId) = $messageId
        WITH p, c, existing
        FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
          CREATE (newE:Entry {
            id: randomUUID(),
            updateId: $updateId,
            messageId: $messageId,
            date: datetime($date),
            source: 'telegram',
            topic: c.topic,
            resolveStatus: 'pending',
            resolvedAt: null
          })-[:SENT_BY]->(p)
          MERGE (newE)-[:FROM_CHAT]->(c)
        )
        WITH p, c
        MATCH (e:Entry)-[:FROM_CHAT]->(c)
        WHERE toInteger(e.messageId) = $messageId
        WITH e, p, c
        ORDER BY e.date ASC
        LIMIT 1

        ${input.textContent ? `
        OPTIONAL MATCH (e)-[:HAS_TEXT]->(existingText:TextContent)
        WITH e, p, c, existingText
        FOREACH (_ IN CASE WHEN existingText IS NULL THEN [1] ELSE [] END |
          CREATE (t:TextContent {id: randomUUID(), text: $text})
          MERGE (e)-[:HAS_TEXT]->(t)
        )
        WITH e, p, c
        ` : ''}

        ${input.captionContent ? `
        OPTIONAL MATCH (e)-[:HAS_CAPTION]->(existingCaption:CaptionContent)
        WITH e, p, c, existingCaption
        FOREACH (_ IN CASE WHEN existingCaption IS NULL THEN [1] ELSE [] END |
          CREATE (cap:CaptionContent {id: randomUUID(), caption: $caption})
          MERGE (e)-[:HAS_CAPTION]->(cap)
        )
        WITH e, p, c
        ` : ''}

        ${input.entities?.length > 0 ? `
        OPTIONAL MATCH (e)-[:HAS_ENTITY]->(existingEntity:Entity)
        WITH e, p, c, count(existingEntity) AS entityCount
        CALL {
          WITH e, entityCount
          WITH e WHERE entityCount = 0
          UNWIND range(0, size($entityOffsets) - 1) AS idxEntity
          CREATE (en:Entity {
            id: randomUUID(),
            offset: $entityOffsets[idxEntity],
            length: $entityLengths[idxEntity],
            type: $entityTypes[idxEntity]
          })
          MERGE (e)-[:HAS_ENTITY]->(en)
          RETURN count(*) AS created
        }
        WITH e, p, c
        ` : ''}

        ${input.photos?.length > 0 ? `
          OPTIONAL MATCH (e)-[:HAS_PHOTO]->(existingPhoto:Photo)
          WITH e, p, c, count(existingPhoto) AS photoCount,
            size($photoFileIds) - 1 AS lastIdx
          FOREACH (_ IN CASE WHEN photoCount = 0 THEN [1] ELSE [] END |
            CREATE (pht:Photo {
              id: randomUUID(),
              fileId: $photoFileIds[lastIdx],
              fileUniqueId: $photoFileUniqueIds[lastIdx],
              fileSize: $photoFileSizes[lastIdx],
              width: $photoWidths[lastIdx],
              height: $photoHeights[lastIdx]
            })
            MERGE (e)-[:HAS_PHOTO]->(pht)
          )
          WITH e, p, c
          ` : ''}

        ${input.voice ? `
        OPTIONAL MATCH (e)-[:HAS_VOICE]->(existingVoice:Voice)
        WITH e, p, c, existingVoice
        FOREACH (_ IN CASE WHEN existingVoice IS NULL THEN [1] ELSE [] END |
          CREATE (vn:Voice {
            id: randomUUID(),
            fileId: $voiceFileId,
            fileUniqueId: $voiceFileUniqueId,
            fileSize: $voiceFileSize,
            duration: $voiceDuration,
            mimeType: $voiceMimeType,
            processingStatus: 'pending',
            retryCount: 0
          })
          MERGE (e)-[:HAS_VOICE]->(vn)
        )
        WITH e, p, c
        ` : ''}

        ${input.videos?.length > 0 ? `
        OPTIONAL MATCH (e)-[:HAS_VIDEO]->(existingVideo:Video)
        WITH e, p, c, count(existingVideo) AS videoCount
        CALL {
          WITH e, videoCount
          WITH e WHERE videoCount = 0
          UNWIND range(0, size($videoFileIds) - 1) AS idxVideo
          CREATE (vid:Video {
            id: randomUUID(),
            duration: $videoDurations[idxVideo],
            width: $videoWidths[idxVideo],
            height: $videoHeights[idxVideo],
            mimeType: $videoMimeTypes[idxVideo],
            fileId: $videoFileIds[idxVideo],
            fileUniqueId: $videoFileUniqueIds[idxVideo],
            fileSize: $videoFileSizes[idxVideo]
          })
          MERGE (e)-[:HAS_VIDEO]->(vid)
          RETURN count(*) AS created
        }
        WITH e, p, c
        ` : ''}

        ${input.videoNote ? `
        OPTIONAL MATCH (e)-[:HAS_VIDEO_NOTE]->(existingVideoNote:VideoNote)
        WITH e, p, c, existingVideoNote
        FOREACH (_ IN CASE WHEN existingVideoNote IS NULL THEN [1] ELSE [] END |
          CREATE (vidnote:VideoNote {
            id: randomUUID(),
            duration: $videoNoteDuration,
            length: $videoNoteLength,
            fileId: $videoNoteFileId,
            fileUniqueId: $videoNoteFileUniqueId,
            fileSize: $videoNoteFileSize
          })
          MERGE (e)-[:HAS_VIDEO_NOTE]->(vidnote)
        )
        WITH e, p, c
        ` : ''}

        ${input.replyTo ? `
        MATCH (repliedTo:Entry)
        WHERE toInteger(repliedTo.messageId) = $replyToMessageId
        MERGE (e)-[:REPLIED_TO]->(repliedTo)
        ` : ''}

        RETURN e.id AS id
      `;
      
      const queryParams = {
        senderHandle: input.participant.handle,
        chatId: input.chat.id,
        chatTitle: input.chat.type === 'private' ? null : input.chat.title,
        chatUsername: input.chat.type === 'private' ? input.chat.username : null,
        chatTopic: input.chat.type === 'private' ? null : input.chat.topic,
        chatType: input.chat.type,
        updateId: neo4j.int(input.entry.updateId),
        messageId: neo4j.int(input.entry.messageId),
        date: input.entry.date,
        text: input.textContent?.text,
        replyToMessageId:
          input.replyTo?.messageId != null
            ? neo4j.int(input.replyTo.messageId)
            : undefined,
        caption: input.captionContent?.caption,
        entityOffsets: input.entities.map(entity => entity.offset),
        entityLengths: input.entities.map(entity => entity.length),
        entityTypes: input.entities.map(entity => entity.type),
        photoFileIds: input.photos.map(photo => photo.fileId),
        photoFileUniqueIds: input.photos.map(photo => photo.fileUniqueId),
        photoFileSizes: input.photos.map(photo => photo.fileSize),
        photoWidths: input.photos.map(photo => photo.width),
        photoHeights: input.photos.map(photo => photo.height),
        voiceFileId: input.voice?.fileId,
        voiceFileUniqueId: input.voice?.fileUniqueId,
        voiceFileSize: input.voice?.fileSize,
        voiceDuration: input.voice?.duration,
        voiceMimeType: input.voice?.mimeType,
        videoFileIds: input.videos.map(video => video.fileId),
        videoFileUniqueIds: input.videos.map(video => video.fileUniqueId),
        videoFileSizes: input.videos.map(video => video.fileSize),
        videoDurations: input.videos.map(video => video.duration),
        videoWidths: input.videos.map(video => video.width),
        videoHeights: input.videos.map(video => video.height),
        videoMimeTypes: input.videos.map(video => video.mimeType),
        videoNoteDuration: input.videoNote?.duration,
        videoNoteLength: input.videoNote?.length,
        videoNoteFileId: input.videoNote?.fileId,
        videoNoteFileUniqueId: input.videoNote?.fileUniqueId,
        videoNoteFileSize: input.videoNote?.fileSize
      };

      // Run the query
      const result = await tx.run(cypherQuery, queryParams);
      logger.info(result.summary.counters.updates());

      logger.debug("Cypher executed", { query: cypherQuery, params: queryParams, resultSummary: result.summary });

      // Return the result
      return result;
    });

    if (!result.records.length) {
      logger.error("No records returned!", { resultSummary: result.summary });
      throw new Error("No records returned from database.");
    }
    return result.records[0].get('id'); 

  } catch (error) {
    logger.error("Error creating entry node:", error);
    throw error;  // Rethrow the error to be handled by the caller
  }
}

export async function readEntry(entryId: string): Promise<FullEntryData> {
  const driver = getDriver();
  const session = driver.session();

  logger.info(`Getting entry node for id ${entryId}`)

  const result = await session.run(
    `
    MATCH (e:Entry {id: $entryId}) 
    OPTIONAL MATCH (e)-[:SENT_BY]->(p:Participant)
    OPTIONAL MATCH (e)-[:FROM_CHAT]->(c:TelegramChat)
    OPTIONAL MATCH (e)-[:HAS_TEXT]->(t:TextContent)
    OPTIONAL MATCH (e)-[:HAS_CAPTION]->(cap:CaptionContent)
    OPTIONAL MATCH (e)-[:HAS_ENTITY]->(en:Entity)
    OPTIONAL MATCH (e)-[:HAS_PHOTO]->(pht:Photo)
    OPTIONAL MATCH (e)-[:HAS_VOICE]->(vn:Voice)
    OPTIONAL MATCH (e)-[:HAS_VIDEO]->(vid:Video)
    OPTIONAL MATCH (e)-[:HAS_VIDEO_NOTE]->(vidnote:VideoNote)
    RETURN e, p, c, t, cap, collect(en) as entities, collect(pht) as photos, vn, collect(vid) as videos, vidnote
    `,
    {
      entryId: entryId, // The ID of the entry you want to retrieve
    }
  );

  // Extract results from the returned data
  const record = result.records[0];

  // Map the nodes from Neo4j query result to your FullEntryData type
  const fullEntryData = mapFullEntryData(record);

  return fullEntryData;
}

export function verifyExpectationsMet(expected: ExpectedEntryMap, entry: FullEntryData): boolean {
  const actual: { [key: string]: number } = {
      entry: entry.entry ? 1 : 0,
      participant: entry.participant ? 1 : 0,
      chat: entry.chat ? 1 : 0,
      textContent: entry.textContent ? 1 : 0,
      captionContent: entry.captionContent ? 1 : 0,
      entities: entry.entities?.length ?? 0,
      photos: entry.photos?.length ?? 0,
      voice: entry.voice ? 1 : 0,
      videos: entry.videos?.length ?? 0,
      videoNote: entry.videoNote ? 1 : 0,
  };


  let allMatch = true;
  const lines: string[] = [];

  for (const [nodeType, expectedCount] of Object.entries(expected)) {
      const actualCount = actual[nodeType] ?? 0;
      const expectedNum = Number(expectedCount);

      if (actualCount !== expectedNum) {
          allMatch = false;
      }

      lines.push(`${nodeType}: expected ${expectedNum}, got ${actualCount}`);
  }

  if (!allMatch) {
      logger.error('Database entry did not match expectations', {
          comparison: lines.join(', '),
          expected,
          actual
      });
  
      throw new Error(`Database mismatch:\n${lines.join(', ')}`);
  }
  

  logger.info("Success!")
  return true;
}
