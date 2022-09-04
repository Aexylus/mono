import {assertHash, Hash, hashOf} from '../hash';
import * as btree from '../btree/mod';
import * as dag from '../dag/mod';
import * as db from '../db/mod';
import type * as sync from '../sync/mod';
import type {ReadonlyJSONValue} from '../json';
import {
  assert,
  assertNotUndefined,
  assertNumber,
  assertObject,
  assertString,
} from '../asserts';
import {hasOwn} from '../has-own';
import {uuid as makeUuid} from '../uuid';
import {
  getRefs,
  newSnapshotCommitData,
  newSnapshotCommitDataDD31,
} from '../db/commit';
import type {MaybePromise} from '../mod';
import type {ClientID} from '../sync/ids.js';

export type ClientMap = ReadonlyMap<sync.ClientID, ClientSDD | ClientDD31>;

export type ClientSDD = {
  /**
   * A UNIX timestamp in milliseconds updated by the client once a minute
   * while it is active and every time the client persists its state to
   * the perdag.
   * Should only be updated by the client represented by this structure.
   */
  readonly heartbeatTimestampMs: number;
  /**
   * The hash of the commit in the perdag this client last persisted.
   * Should only be updated by the client represented by this structure.
   */
  readonly headHash: Hash;
  /**
   * The mutationID of the commit at headHash (mutationID if it is a
   * local commit, lastMutationID if it is an index change or snapshot commit).
   * Should only be updated by the client represented by this structure.
   * Read by other clients to determine if there are unacknowledged pending
   * mutations for them to push on behalf of the client represented by this
   * structure.
   * This is redundant with information in the commit graph at headHash,
   * but allows other clients to determine if there are unacknowledged pending
   * mutations without having to load the commit graph at headHash.
   */
  readonly mutationID: number;
  /**
   * The highest lastMutationID received from the server for this client.
   *
   * Should be updated by the client represented by this structure whenever
   * it persists its state to the perdag.
   * Read by other clients to determine if there are unacknowledged pending
   * mutations for them to push on behalf of the client represented by this
   * structure, and *updated* by other clients upon successfully pushing
   * pending mutations to avoid redundant pushes of those mutations.
   *
   * Note: This will be the same as the lastMutationID of the base snapshot of
   * the commit graph at headHash when written by the client represented by this
   * structure.  However, when written by another client pushing pending
   * mutations on this client's behalf it will be different.  This is because
   * the other client does not update the commit graph (it is unsafe to update
   * another client's commit graph).
   */
  readonly lastServerAckdMutationID: number;
};

export type ClientDD31 = {
  readonly heartbeatTimestampMs: number;
  readonly headHash: Hash;

  /**
   * The hash of a commit we are in the middle of refreshing into this client's
   * memdag.
   */
  readonly tempRefreshHash?: Hash;

  /**
   * ID of this client's perdag branch. This needs to be sent in pull request
   * (to enable syncing all last mutation ids in the branch).
   */
  readonly branchID: sync.BranchID;
};

export type Client = ClientSDD | ClientDD31;

export function isClientDD31(client: Client): client is ClientDD31 {
  return DD31 && (client as ClientDD31).branchID !== undefined;
}

export function isClientSDD(client: Client): client is ClientSDD {
  return !DD31 || (client as ClientSDD).lastServerAckdMutationID !== undefined;
}

export const CLIENTS_HEAD_NAME = 'clients';

function assertClient(value: unknown): asserts value is Client {
  assertClientBase(value);

  if (typeof value.mutationID === 'number') {
    assertNumber(value.lastServerAckdMutationID);
  } else {
    const {tempRefreshHash} = value;
    if (tempRefreshHash) {
      assertHash(tempRefreshHash);
    }
    assertString(value.branchID);
  }
}

function assertClientBase(value: unknown): asserts value is {
  heartbeatTimestampMs: number;
  headHash: Hash;
  [key: string]: unknown;
} {
  assertObject(value);
  const {heartbeatTimestampMs, headHash} = value;
  assertNumber(heartbeatTimestampMs);
  assertHash(headHash);
}

export function assertClientSDD(value: unknown): asserts value is ClientSDD {
  assertClientBase(value);
  const {mutationID, lastServerAckdMutationID} = value;
  assertNumber(mutationID);
  assertNumber(lastServerAckdMutationID);
}

export function assertClientDD31(value: unknown): asserts value is ClientDD31 {
  assert(DD31);
  assertClientBase(value);
  const {tempRefreshHash} = value;
  if (tempRefreshHash) {
    assertHash(tempRefreshHash);
  }
  assertString(value.branchID);
}

function chunkDataToClientMap(chunkData: unknown): ClientMap {
  assertObject(chunkData);
  const clients = new Map();
  for (const key in chunkData) {
    if (hasOwn(chunkData, key)) {
      const value = chunkData[key];
      if (value !== undefined) {
        assertClient(value);
        clients.set(key, value);
      }
    }
  }
  return clients;
}

function clientMapToChunkData(
  clients: ClientMap,
  dagWrite: dag.Write,
): ReadonlyJSONValue {
  clients.forEach(client => {
    dagWrite.assertValidHash(client.headHash);
    if (isClientDD31(client) && client.tempRefreshHash) {
      dagWrite.assertValidHash(client.tempRefreshHash);
    }
  });
  return Object.fromEntries(clients);
}

function clientMapToChunkDataNoHashValidation(
  clients: ClientMap,
): ReadonlyJSONValue {
  return Object.fromEntries(clients);
}

export async function getClients(dagRead: dag.Read): Promise<ClientMap> {
  const hash = await dagRead.getHead(CLIENTS_HEAD_NAME);
  return getClientsAtHash(hash, dagRead);
}

async function getClientsAtHash(
  hash: Hash | undefined,
  dagRead: dag.Read,
): Promise<ClientMap> {
  if (!hash) {
    return new Map();
  }
  const chunk = await dagRead.getChunk(hash);
  return chunkDataToClientMap(chunk?.data);
}

/**
 * Used to signal that a client does not exist. Maybe it was garbage collected?
 */
export class ClientStateNotFoundError extends Error {
  name = 'ClientStateNotFoundError';
  readonly id: string;
  constructor(id: sync.ClientID) {
    super(`Client state not found, id: ${id}`);
    this.id = id;
  }
}

/**
 * Throws a `ClientStateNotFoundError` if the client does not exist.
 */
export async function assertHasClientState(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<void> {
  if (!(await hasClientState(id, dagRead))) {
    throw new ClientStateNotFoundError(id);
  }
}

export async function hasClientState(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<boolean> {
  return !!(await getClient(id, dagRead));
}

export async function getClient(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<Client | undefined> {
  const clients = await getClients(dagRead);
  return clients.get(id);
}

export async function initClient(
  dagStore: dag.Store,
): Promise<[sync.ClientID, Client, ClientMap]> {
  const newClientID = makeUuid();
  const updatedClients = await updateClients(async clients => {
    let bootstrapClient: Client | undefined;
    for (const client of clients.values()) {
      if (
        !bootstrapClient ||
        bootstrapClient.heartbeatTimestampMs < client.heartbeatTimestampMs
      ) {
        bootstrapClient = client;
      }
    }

    let newClientCommitData;
    const chunksToPut = [];
    if (bootstrapClient) {
      const constBootstrapClient = bootstrapClient;
      newClientCommitData = await dagStore.withRead(async dagRead => {
        const bootstrapCommit = await db.baseSnapshot(
          constBootstrapClient.headHash,
          dagRead,
        );
        // Copy the snapshot with one change: set last mutation id to 0.  Replicache
        // server implementations expect new client ids to start with last mutation id 0.
        // If a server sees a new client id with a non-0 last mutation id, it may conclude
        // this is a very old client whose state has been garbage collected on the server.
        if (DD31) {
          return newSnapshotCommitDataDD31(
            bootstrapCommit.meta.basisHash,
            {[newClientID]: 0},
            bootstrapCommit.meta.cookieJSON,
            bootstrapCommit.valueHash,
            bootstrapCommit.indexes,
          );
        }
        return newSnapshotCommitData(
          bootstrapCommit.meta.basisHash,
          0 /* lastMutationID */,
          bootstrapCommit.meta.cookieJSON,
          bootstrapCommit.valueHash,
          bootstrapCommit.indexes,
        );
      });
    } else {
      // No existing snapshot to bootstrap from. Create empty snapshot.
      const emptyBTreeChunk = await dag.createChunkWithNativeHash(
        btree.emptyDataNode,
        [],
      );
      chunksToPut.push(emptyBTreeChunk);
      if (DD31) {
        newClientCommitData = newSnapshotCommitDataDD31(
          null,
          {[newClientID]: 0},
          null,
          emptyBTreeChunk.hash,
          [],
        );
      } else {
        newClientCommitData = newSnapshotCommitData(
          null /* basisHash */,
          0 /* lastMutationID */,
          null /* cookie */,
          emptyBTreeChunk.hash,
          [] /* indexes */,
        );
      }
    }

    const newClientCommitChunk = await dag.createChunkWithNativeHash(
      newClientCommitData,
      getRefs(newClientCommitData),
    );
    chunksToPut.push(newClientCommitChunk);

    return {
      clients: new Map(clients).set(newClientID, {
        heartbeatTimestampMs: Date.now(),
        headHash: newClientCommitChunk.hash,
        // TODO(DD31): tempRefreshHash and branchID
        mutationID: 0,
        lastServerAckdMutationID: 0,
      }),
      chunksToPut,
    };
  }, dagStore);
  const newClient = updatedClients.get(newClientID);
  assertNotUndefined(newClient);
  return [newClientID, newClient, updatedClients];
}

function asyncHashOfClients(clients: ClientMap): Promise<Hash> {
  const data = clientMapToChunkDataNoHashValidation(clients);
  return hashOf(data);
}

export const noUpdates = Symbol();
export type NoUpdates = typeof noUpdates;

type ClientsUpdate = (
  clients: ClientMap,
) => MaybePromise<
  {clients: ClientMap; chunksToPut?: Iterable<dag.Chunk>} | NoUpdates
>;

export async function updateClients(
  update: ClientsUpdate,
  dagStore: dag.Store,
): Promise<ClientMap> {
  const [clients, clientsHash] = await dagStore.withRead(async dagRead => {
    const clientsHash = await dagRead.getHead(CLIENTS_HEAD_NAME);
    const clients = await getClientsAtHash(clientsHash, dagRead);
    return [clients, clientsHash];
  });
  return updateClientsInternal(update, clients, clientsHash, dagStore);
}

async function updateClientsInternal(
  update: ClientsUpdate,
  clients: ClientMap,
  clientsHash: Hash | undefined,
  dagStore: dag.Store,
): Promise<ClientMap> {
  const updateResults = await update(clients);
  if (updateResults === noUpdates) {
    return clients;
  }
  const {clients: updatedClients, chunksToPut} = updateResults;
  const updatedClientsHash = await asyncHashOfClients(updatedClients);
  const result = await dagStore.withWrite(async dagWrite => {
    const currClientsHash = await dagWrite.getHead(CLIENTS_HEAD_NAME);
    if (currClientsHash !== clientsHash) {
      // Conflict!  Someone else updated the ClientsMap.  Retry update.
      return {
        updateApplied: false,
        clients: await getClientsAtHash(currClientsHash, dagWrite),
        clientsHash: currClientsHash,
      };
    }
    const updatedClientsChunkData = clientMapToChunkData(
      updatedClients,
      dagWrite,
    );

    const updateClientsRefs: Hash[] = getRefsForClients(updatedClients);

    const updateClientsChunk = dag.createChunkWithHash(
      updatedClientsHash,
      updatedClientsChunkData,
      updateClientsRefs,
    );
    const chunksToPutPromises: Promise<void>[] = [];
    if (chunksToPut) {
      for (const chunk of chunksToPut) {
        chunksToPutPromises.push(dagWrite.putChunk(chunk));
      }
    }
    await Promise.all([
      ...chunksToPutPromises,
      dagWrite.putChunk(updateClientsChunk),
      dagWrite.setHead(CLIENTS_HEAD_NAME, updateClientsChunk.hash),
    ]);
    await dagWrite.commit();
    return {
      updateApplied: true,
      clients: updatedClients,
      clientsHash: updatedClientsHash,
    };
  });
  if (result.updateApplied) {
    return result.clients;
  }
  return updateClientsInternal(
    update,
    result.clients,
    result.clientsHash,
    dagStore,
  );
}

function getRefsForClients(clients: ClientMap): Hash[] {
  const refs: Hash[] = [];
  for (const client of clients.values()) {
    refs.push(client.headHash);
    if (DD31 && isClientDD31(client) && client.tempRefreshHash) {
      refs.push(client.tempRefreshHash);
    }
  }
  return refs;
}

/**
 * Adds a Client to the ClientMap and updates the 'clients' head top point at
 * the updated clients.
 */
export async function setClient(
  clientID: ClientID,
  client: Client,
  dagWrite: dag.Write,
): Promise<Hash> {
  const clientsHash = await dagWrite.getHead(CLIENTS_HEAD_NAME);
  const clients = await getClientsAtHash(clientsHash, dagWrite);
  const newClients = new Map(clients).set(clientID, client);

  const chunkData = clientMapToChunkData(newClients, dagWrite);
  const chunk = dagWrite.createChunk(chunkData, getRefsForClients(newClients));
  await dagWrite.putChunk(chunk);
  await dagWrite.setHead(CLIENTS_HEAD_NAME, chunk.hash);
  return chunk.hash;
}
