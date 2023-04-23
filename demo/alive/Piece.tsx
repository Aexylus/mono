import classNames from 'classnames';
import {PIECE_DEFINITIONS} from './piece-definitions';
import React, {PointerEventHandler} from 'react';
import type {PieceInfo} from './piece-info';
import type {ClientModel} from './client-model';
import {center} from './util';

export type HoverState = 'hover' | 'wait' | 'none';

export function Piece({
  piece,
  hovered,
  selectorID,
  myClient,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onRotationStart,
}: {
  piece: PieceInfo;
  hovered: boolean;
  selectorID: string | null;
  myClient: ClientModel;
  onPointerDown: PointerEventHandler;
  onPointerOver: PointerEventHandler;
  onPointerOut: PointerEventHandler;
  onRotationStart: (e: React.PointerEvent) => void;
}) {
  const def = PIECE_DEFINITIONS[parseInt(piece.id)];

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    onPointerDown(e);
  };

  const handleRotationStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    onRotationStart(e);
  };

  const active = hovered || selectorID;

  const c = center({
    x: piece.x,
    y: piece.y,
    width: def.width,
    height: def.height,
  });
  const handleSize = 28; // see css
  const handlePos = {
    x: c.x - handleSize / 2,
    y: c.y - handleSize / 2,
  };

  return (
    <>
      <svg
        version="1.1"
        viewBox={`0 0 ${def.width} ${def.height}`}
        width={def.width}
        height={def.height}
        className={classNames('piece', def.letter, {
          placed: piece.placed,
          active,
        })}
        style={{
          transform: `translate3d(${piece.x}px, ${piece.y}px, 0px) rotate(${piece.rotation}rad)`,
        }}
        onPointerDown={e => handlePointerDown(e)}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
      >
        {
          // TODO: We shouldn't really duplicate the id "shape" here but the CSS already had it that way.
        }
        <path id="shape" d={def.paths[0]} strokeWidth="1" />
      </svg>
      <div
        className={classNames('rotation-handle', {
          active,
          // TODO: would also be nice to animate out, but that's a bit more complicated and this look good enough.
          animate: hovered || selectorID === myClient.id,
        })}
        style={{
          transform: `translate3d(${handlePos.x}px, ${
            handlePos.y
          }px, 0px) rotate(${-piece.handleRotation}rad)`,
        }}
      >
        <div
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
          onPointerDown={e => handleRotationStart(e)}
        >
          <div></div>
        </div>
      </div>
    </>
  );
}
