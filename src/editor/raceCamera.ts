import type { SpectatorFrame } from "../domain/track/types";

export function raceCameraLayout(
  frame: SpectatorFrame,
  width: number,
  height: number,
) {
  const available = {
    x: 20,
    y: 60,
    width: Math.max(1, width - 40),
    height: Math.max(1, height - 100),
  };
  const zoom = Math.min(
    available.width / frame.size.x,
    available.height / frame.size.y,
  );
  const screenCenter = {
    x: available.x + available.width / 2,
    y: available.y + available.height / 2,
  };
  return {
    center: frame.center,
    rotation: frame.rotation,
    zoom,
    screenCenter,
    rect: {
      x: screenCenter.x - (frame.size.x * zoom) / 2,
      y: screenCenter.y - (frame.size.y * zoom) / 2,
      width: frame.size.x * zoom,
      height: frame.size.y * zoom,
    },
  };
}
