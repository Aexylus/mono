// Processes zero or more mutations against a room, returning necessary pokes

import type {LogContext} from '@rocicorp/logger';
import {must} from 'shared/src/must.js';
import {fastForwardRoom} from '../ff/fast-forward.js';
import type {DisconnectHandler} from '../server/disconnect.js';
import type {DurableStorage} from '../storage/durable-storage.js';
import {EntryCache} from '../storage/entry-cache.js';
import type {ClientPoke} from '../types/client-poke.js';
import {getClientRecord, putClientRecord} from '../types/client-record.js';
import type {ClientMap} from '../types/client-state.js';
import type {PendingMutation} from '../types/mutation.js';
import {getVersion, putVersion} from '../types/version.js';
import {processFrame} from './process-frame.js';
import type {MutatorMap} from './process-mutation.js';

export const FRAME_LENGTH_MS = 1000 / 60;

/**
 * Process all pending mutations that are ready to be processed for a room.
 * @param clients active clients in the room
 * @param clientGroups client groups with pending mutations
 * @param mutators all known mutators
 * @param durable storage to read/write to
 * @param timestamp timestamp to put in resulting pokes
 */
export async function processRoom(
  lc: LogContext,
  clients: ClientMap,
  pendingMutations: PendingMutation[],
  mutators: MutatorMap,
  disconnectHandler: DisconnectHandler,
  storage: DurableStorage,
): Promise<ClientPoke[]> {
  const cache = new EntryCache(storage);
  const clientIDs = [...clients.keys()];
  lc.debug?.(
    'processing room',
    'clientIDs',
    [...clientIDs.entries()],
    ' pendingMutations',
    [...pendingMutations.entries()],
  );

  // Before running any mutations, fast forward connected clients to
  // current state.
  let currentVersion = await getVersion(cache);
  if (currentVersion === undefined) {
    currentVersion = 0;
    await putVersion(currentVersion, cache);
  }
  lc.debug?.('currentVersion', currentVersion);
  const clientPokes: ClientPoke[] = await fastForwardRoom(
    clientIDs,
    currentVersion,
    storage,
  );
  lc.debug?.('pokes from fastforward', JSON.stringify(clientPokes));

  for (const ffClientPoke of clientPokes) {
    const cr = must(
      await getClientRecord(ffClientPoke.clientID, cache),
      `Client record not found: ${ffClientPoke.clientID}`,
    );
    cr.baseCookie = ffClientPoke.poke.cookie;
    await putClientRecord(ffClientPoke.clientID, cr, cache);
  }

  clientPokes.push(
    ...(await processFrame(
      lc,
      pendingMutations,
      mutators,
      disconnectHandler,
      clients,
      cache,
    )),
  );

  await cache.flush();
  return clientPokes;
}
