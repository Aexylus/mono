import type {ClientMap} from '../types/client-state.js';
import type {LogContext} from '@rocicorp/logger';
import {closeWithError} from '../util/socket.js';
import {NumericErrorKind} from '../protocol/error.js';

export function handleAuthInvalidate(
  lc: LogContext,
  clients: ClientMap,
  userID?: string,
): Response {
  let closedCount = 0;
  for (const clientState of clients.values()) {
    if (userID === undefined || userID === clientState.userData.userID) {
      closeWithError(lc, clientState.socket, NumericErrorKind.AuthInvalidated);
      closedCount++;
    }
  }
  lc.debug?.('Closed', closedCount, 'connections.');
  return new Response('Success', {status: 200});
}
