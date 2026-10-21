# MAX Tennis Game

A 3D arcade tennis game you play in the browser. Rally against an AI opponent, or
send a friend a link and play them directly: the two browsers talk to each other
peer-to-peer over WebRTC, so there is no game server in between. Built with React,
Vite and TypeScript.

## How to play

| Control | Action |
| --- | --- |
| `W` `A` `S` `D` | Move your player |
| Mouse | Aims the target marker on the court |
| Left click | Hit the ball |
| Hold right click | Charge power |
| `C` | Switch camera view |
| `V` | Turn the umpire's score calls on or off |

Where you point the marker is where the ball is headed, so aiming matters as much
as timing. If you do not click in time, an auto-swing covers you, though a
deliberate shot gives you far more control.

First to 10 points wins, and you have to win by 2.

## Customize your player

Press **Customize** on the main menu (or on the name screen when joining a
friend) to change your player's look, with a 3D preview you can drag to turn:

- **Hair:** style and colour
- **Skin:** tone
- **Shirt:** colour, design (stripes, hoops, sash, star or your own number),
  design colour, and shorts colour
- **Shoes:** colour
- **Face:** happy, focused, angry, surprised or cool
- **Extras:** a cap, headband or wristbands, and your racket colour

**Randomize** rolls a whole new look. Your look is saved in your browser, and
in an online match your opponent sees it too.

## Playing with a friend

1. The host creates a room.
2. The host shares the room link.
3. The friend opens the link and enters a name.
4. They join, and the match begins.

The connection is peer-to-peer over WebRTC; there is no game server, so the two
browsers exchange game state directly.

## Local development

```bash
npm install
npm run dev
```

## Simulation checks

The rules engine has a headless check suite. Run it with:

```bash
npm run check:sim
```

## Deployment

Pushes to `main` build and deploy to GitHub Pages automatically through the
workflow in `.github/workflows/deploy.yml`.

For this to work, GitHub Pages has to be enabled on the repository: go to
**Settings > Pages** and set the source to **GitHub Actions**.

## A note on devices

This is desktop-first. It needs a keyboard and a mouse, since movement is on WASD
and both aiming and hitting are on the mouse. Phones and tablets are not supported
for play.
