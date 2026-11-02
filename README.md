# Game Night

Five small browser games to play on a phone or computer, against the computer or online with friends.

**Play:** https://hkarimi561.github.io/games/

| Game | Players | Folder |
| --- | --- | --- |
| Three-Way Dots (Dots & Boxes) | 2–6, computer players | [`dots/`](dots/) |
| Fleet Command (Battleship) | 2, computer opponent | [`battleship/`](battleship/) |
| Liar's Dice | 2–6, computer players | [`liars-dice/`](liars-dice/) |
| Minesweeper Race | 1+, computer rival | [`minesweeper/`](minesweeper/) |
| Snake Arena | up to 6, computer snakes | [`snake/`](snake/) |

## Playing online

1. Open a game and tap **Online**, then **Create a room**.
2. Tap **Invite friends** to share the link (it contains the room code), or tell friends the 5-letter code.
3. Everyone keeps the page open while playing. The room lives in the browser of the person who created it, so if they close the page, the room ends.

No sign-up and no server of our own: devices connect directly with WebRTC, using the free [PeerJS](https://peerjs.com) connection service to find each other (and its relay servers when a direct connection isn't possible). Hidden information stays on each player's device: your ship positions in Fleet Command and your dice in Liar's Dice are never sent to the other players until the rules reveal them.

## How it's built

- Each game is one self-contained `index.html` with no build step.
- `assets/net.js` provides the online rooms: the room creator's browser holds the shared game state and relays live moves; everyone else reads and writes through it.
- `assets/peerjs.min.js` is PeerJS 1.5.4 (MIT license, see `assets/peerjs.LICENSE`).

To run locally, serve the folder with any static server, for example `python3 -m http.server`, and open http://localhost:8000.
