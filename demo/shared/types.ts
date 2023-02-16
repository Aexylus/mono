// Per-frame application state. We query reflect directly for this data every
// time we draw.
export type State = {
  actorId: ActorID;
  actors: Record<ActorID, Actor>;
  cursors: Record<ActorID, Cursor>;
  points: Record<Letter, Point[]>;
  rawCaches: Record<Letter, string>;
  sequences: Record<Letter, number>;
  impulses: Record<Letter, Impulse[]>;
  physics: Physics | undefined;
};

export type ActorID = string;

export type Color = [number, number, number]; // rgb

export type ColorPalate = [
  [Color, Color],
  [Color, Color],
  [Color, Color],
  [Color, Color],
  [Color, Color],
];

export type Actor = {
  id: ActorID;
  colorIndex: number;
  location: string;
  isBot: boolean;
};

export type LetterCache = {
  letter: Letter;
  cache: string;
};

export type Letter3DPosition = {
  position: Vector;
  rotation: Quaternion;
};

export type Impulse = Vector & {
  u: ActorID;
  s: number; // step
};

export type LetterHandles = Record<Letter, number>;

export type Physics = {
  state: string; // b64 encoded
  step: number;
  handles: LetterHandles;
};

export enum Letter {
  A = 'a',
  L = 'l',
  I = 'i',
  V = 'v',
  E = 'e',
}

// Each letter also can be painted on, by adding points.
export type Point = Position & {
  u: ActorID; // actor ID
  t: number; // timestamp
  c: number; // color index, from COLOR_PALATE
  s: number; // scale that this point was drawn at
  p: Splatter[]; // splatters
  g: number; // group
};

export type Splatter = Position & {
  s: number; // size
};

// Each actor has a cursor. They are positioned in global space, so we also need
// to send the space around so we can draw them relatively.
export type Cursor = Position & {
  actorId: ActorID;
  onPage: boolean;
  ts: number;
  isDown: boolean;
};

export type BoundingBox = Position & Size;

export type Size = {
  width: number;
  height: number;
};

export type Quaternion = Vector & {
  w: number;
};

export type Vector = Position & {
  z: number;
};

// In this app, all position values are between 0 and 1, and expected to be
// multiplied by window.innerWidth/window.innerHeight when used in rendering
// code.
export type Position = {
  x: number;
  y: number;
};
