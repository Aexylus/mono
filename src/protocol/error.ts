import * as s from 'superstruct';

// Keep this in sync with reflect client

// WebSocket close codes:
//
// 4000-4999
//
// Status codes in the range 4000-4999 are reserved for private use
// and thus can't be registered.  Such codes can be used by prior
// agreements between WebSocket applications.  The interpretation of
// these codes is undefined by this protocol.

// Make sure we do not export this from mod.ts
export const enum NumericErrorKind {
  AuthInvalidated = 4000,
  ClientNotFound,
  InvalidConnectionRequest,
  InvalidMessage,
  RoomClosed,
  RoomNotFound,
  Unauthorized,
  UnexpectedBaseCookie,
  UnexpectedLastMutationID,
}

const mapping = {
  /* eslint-disable @typescript-eslint/naming-convention */
  AuthInvalidated: NumericErrorKind.AuthInvalidated,
  ClientNotFound: NumericErrorKind.ClientNotFound,
  InvalidConnectionRequest: NumericErrorKind.InvalidConnectionRequest,
  InvalidMessage: NumericErrorKind.InvalidMessage,
  RoomClosed: NumericErrorKind.RoomClosed,
  RoomNotFound: NumericErrorKind.RoomNotFound,
  Unauthorized: NumericErrorKind.Unauthorized,
  UnexpectedBaseCookie: NumericErrorKind.UnexpectedBaseCookie,
  UnexpectedLastMutationID: NumericErrorKind.UnexpectedLastMutationID,
  /* eslint-enable @typescript-eslint/naming-convention */
} as const;

export type ErrorKind = keyof typeof mapping;

const reverseMapping = new Map(Object.entries(mapping).map(([k, v]) => [v, k]));

export const errorKindSchema = s.union([
  s.literal(NumericErrorKind.AuthInvalidated),
  s.literal(NumericErrorKind.ClientNotFound),
  s.literal(NumericErrorKind.InvalidConnectionRequest),
  s.literal(NumericErrorKind.InvalidMessage),
  s.literal(NumericErrorKind.RoomClosed),
  s.literal(NumericErrorKind.RoomNotFound),
  s.literal(NumericErrorKind.Unauthorized),
  s.literal(NumericErrorKind.UnexpectedBaseCookie),
  s.literal(NumericErrorKind.UnexpectedLastMutationID),
]);

export function castToErrorKind(n: number): NumericErrorKind | undefined {
  return n >= NumericErrorKind.AuthInvalidated &&
    n <= NumericErrorKind.UnexpectedLastMutationID
    ? (n as NumericErrorKind)
    : undefined;
}

export function errorKindToString(kind: NumericErrorKind): ErrorKind {
  return reverseMapping.get(kind) as ErrorKind;
}

export const errorMessageSchema = s.tuple([
  s.literal('error'),
  errorKindSchema,
  s.string(),
]);

export type ErrorMessage = s.Infer<typeof errorMessageSchema>;
