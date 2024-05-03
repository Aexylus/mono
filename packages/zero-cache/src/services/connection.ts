import type {LogContext} from '@rocicorp/logger';
import {Downstream, Upstream, upstreamSchema} from 'zero-protocol';
import type {ServiceRunner} from './service-runner.js';
import type {ViewSyncerService} from './view-syncer/view-syncer.js';
import * as valita from 'shared/src/valita.js';
// TODO(mlaw): break dependency on reflect-server
import {handlePing} from 'reflect-server/ping';
import {sendError} from 'reflect-server/socket';
import {Subscription} from '../types/subscription.js';
import type {CancelableAsyncIterable} from '../types/streams.js';
import {must} from 'shared/src/must.js';
import type {PostgresDB} from '../types/pg.js';
import {processMutation} from './mutagen/mutagen.js';

/**
 * Represents a connection between the client and server.
 *
 * Handles incoming messages on the connection and dispatches
 * them to the correct service.
 *
 * Listens to the ViewSyncer and sends messages to the client.
 */
export class Connection {
  readonly #clientID: string;
  readonly #ws: WebSocket;
  readonly #lc: LogContext;
  readonly #baseCookie: string | null;
  readonly #upstreamDB: PostgresDB;

  readonly #viewSyncer: ViewSyncerService;

  #inboundStream: Subscription<Upstream> | undefined;
  #outboundStream: CancelableAsyncIterable<Downstream> | undefined;

  constructor(
    lc: LogContext,
    db: PostgresDB,
    serviceRunner: ServiceRunner,
    clientGroupID: string,
    clientID: string,
    baseCookie: string | null,
    ws: WebSocket,
  ) {
    this.#clientID = clientID;
    this.#ws = ws;
    this.#lc = lc;
    this.#baseCookie = baseCookie;
    this.#upstreamDB = db;

    this.#viewSyncer = serviceRunner.getViewSyncer(clientGroupID);
    this.#ws.addEventListener('message', this.#onMessage);
  }

  close() {
    this.#ws.close();
  }

  #onMessage = async (event: MessageEvent) => {
    const lc = this.#lc;
    const data = event.data.toString();
    const ws = this.#ws;
    const viewSyncer = this.#viewSyncer;

    let msg;
    try {
      const value = JSON.parse(data);
      msg = valita.parse(value, upstreamSchema);
    } catch (e) {
      sendError(lc, ws, 'InvalidMessage', String(e));
      return;
    }

    const msgType = msg[0];
    switch (msgType) {
      case 'ping':
        handlePing(lc, ws);
        break;
      case 'push':
        for (const mutation of msg[1].mutations) {
          await processMutation(lc, this.#upstreamDB, mutation);
        }
        break;
      case 'pull':
        must(this.#inboundStream).push(msg);
        break;
      case 'changeDesiredQueries':
        must(this.#inboundStream).push(msg);
        break;
      case 'deleteClients':
        must(this.#inboundStream).push(msg);
        break;
      case 'initConnection': {
        this.#inboundStream = new Subscription<Upstream>();
        this.#inboundStream.push(msg);
        this.#outboundStream = await viewSyncer.sync(
          {
            clientID: this.#clientID,
            baseCookie: this.#baseCookie,
          },
          this.#inboundStream,
        );

        for await (const outMsg of this.#outboundStream) {
          ws.send(JSON.stringify(outMsg));
        }
        break;
      }
      default:
        msgType satisfies never;
    }
  };
}

export function send(ws: WebSocket, data: Downstream) {
  ws.send(JSON.stringify(data));
}
