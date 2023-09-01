import {describe, test, jest, expect, beforeEach} from '@jest/globals';
import type {Auth} from 'firebase-admin/auth';
import type {https} from 'firebase-functions/v2';
import {mockFunctionParamsAndSecrets} from '../../test-helpers.js';
import {tail} from './tail.handler.js';
import {fakeFirestore} from 'mirror-schema/src/test-helpers.js';
import {getMockReq, getMockRes} from '@jest-mock/express';
import {setUser, setApp} from 'mirror-schema/src/test-helpers.js';
import type WebSocket from 'ws';
import {sleep} from 'shared/src/sleep.js';
import type {Firestore} from '@google-cloud/firestore';

export class MockSocket {
  readonly url: string | URL;
  protocol: string;
  messages: string[] = [];
  closed = false;
  onUpstream?: (message: string) => void;
  onclose?: (event: WebSocket.CloseEvent) => void;
  onerror?: (event: WebSocket.ErrorEvent) => void;
  onmessage?: (event: WebSocket.MessageEvent) => void;
  constructor(url: string | URL, protocol = '') {
    this.url = url;
    this.protocol = protocol;
  }
  message(message: string) {
    this.onmessage?.({
      data: Buffer.from(message, 'utf8'),
      type: 'message',
      target: this as unknown as WebSocket,
    });
  }
  send(message: string) {
    this.messages.push(message);
    this.onUpstream?.(message);
  }

  close() {
    this.closed = true;
    const closeEvent = {
      code: 1000,
      reason: 'mock close',
      wasClean: true,
      target: this as unknown as WebSocket,
      type: 'close',
    };
    this.onclose?.(closeEvent);
  }
}

mockFunctionParamsAndSecrets();

describe('test tail', () => {
  let firestore: Firestore & firebase.default.firestore.Firestore;
  let auth: Auth;
  let wsMock: MockSocket;
  let createTailFunction: (
    req: https.Request,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: any,
  ) => void | Promise<void>;
  let createCloudflareTailMockPromise: Promise<void>;
  let createCloudflareTailResolver: () => void;

  beforeEach(async () => {
    firestore = fakeFirestore();
    wsMock = new MockSocket('wss://example.com');

    auth = {
      verifyIdToken: jest
        .fn()
        .mockImplementation(() => Promise.resolve({uid: 'foo'})),
    } as unknown as Auth;

    createCloudflareTailMockPromise = new Promise<void>(resolve => {
      createCloudflareTailResolver = resolve;
    });

    const createCloudflareTailMock = () => {
      setTimeout(createCloudflareTailResolver, 0);
      return Promise.resolve({
        ws: wsMock as unknown as WebSocket,
        expiration: new Date(),
        deleteTail: () => Promise.resolve(),
      });
    };

    createTailFunction = tail(firestore, auth, createCloudflareTailMock);
    await setUser(firestore, 'foo', 'foo@bar.com', 'bob', {fooTeam: 'admin'});
    await setApp(firestore, 'myApp', {teamID: 'fooTeam', name: 'MyAppName'});
  });

  const getRequestWithHeaders = (): https.Request =>
    getMockReq({
      body: {
        requester: {
          userID: 'foo',
          userAgent: {type: 'reflect-cli', version: '0.0.1'},
        },
        appID: 'myApp',
      },
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Authorization: 'Bearer this-is-the-encoded-token',
      },
    }) as unknown as https.Request;

  test('valid auth in header', async () => {
    const req = getRequestWithHeaders();

    console.log('req', req.body);
    const {res} = getMockRes();
    req.res = res;
    const createTailPromise = createTailFunction(req, res);
    await createCloudflareTailMockPromise;
    wsMock.close();
    await createTailPromise;
    expect(auth.verifyIdToken).toBeCalledWith('this-is-the-encoded-token');
  });

  test('handle message', async () => {
    const req = getRequestWithHeaders();

    const {res} = getMockRes();
    req.res = res;
    const createTailPromise = createTailFunction(req, res);
    await createCloudflareTailMockPromise;
    wsMock.message(
      JSON.stringify({
        outcome: 'ok',
        scriptName: 'arv-cli-test-1',
        diagnosticsChannelEvents: [],
        exceptions: [],
        logs: [
          {
            message: [
              'component=Worker',
              'scheduled=ry5fw9fphyb',
              'Handling scheduled event',
            ],
            level: 'info',
            timestamp: 1691593226241,
          },
          {
            message: [
              'component=Worker',
              'scheduled=ry5fw9fphyb',
              'Returning early because REFLECT_AUTH_API_KEY is not defined in env.',
            ],
            level: 'debug',
            timestamp: 1691593226241,
          },
        ],
        eventTimestamp: 1691593226234,
        event: {
          cron: '* /5 * * * *',
          scheduledTime: 1691593225000,
        },
      }),
    );
    await sleep(1);
    expect(res.write).toBeCalledTimes(2);
    expect(req.res.write).toBeCalledWith(
      `data: {"message":["component=Worker","scheduled=ry5fw9fphyb","Returning early because REFLECT_AUTH_API_KEY is not defined in env."],"level":"debug","timestamp":1691593226241}\n\n`,
    );
    wsMock.close();
    await createTailPromise;
    expect(auth.verifyIdToken).toBeCalledWith('this-is-the-encoded-token');
  });
});