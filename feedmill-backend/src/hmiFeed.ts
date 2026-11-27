import { WebSocket } from 'ws';

type Socket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>;

// One screen's update stream. A paced screen has one update on the way at a time and confirms each one, so updates
// cannot pile up on a slow link and the screen is never more than about one update behind.
export function screenFeed(ws: Socket, paced: boolean, latest: () => string) {
  let unconfirmed = false, heldBack = false;
  function send(snapshot: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (unconfirmed) { heldBack = true; return; }
    // a page loaded before this version does not confirm: it only skips while the last update is still in the socket
    if (!paced && ws.bufferedAmount > 0) return;
    unconfirmed = paced;
    ws.send(snapshot);
  }
  return {
    send,
    confirm() {
      unconfirmed = false;
      if (heldBack) { heldBack = false; send(latest()); }
    },
  };
}
