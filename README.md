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

## Playing online

Press **Play with a Friend** to open a room. Then either:

- **Wait for someone online.** Your room appears in the **Online rooms** list
  on everyone's main menu, and anyone can press **Join**.
- **Invite a friend.** Send them the room link; they open it and join.

A room only stays in the list while it can be joined. It disappears as soon as
someone joins, the match starts, or the host cancels or closes the page. Turn
off **Show in online rooms** in your room to keep it private, so that only
people with the link can join. If someone tries to join a room that just
filled, they are told it is full.

There is no game server. The two players' browsers exchange game state
directly over WebRTC, and the room list is kept by one of the online players'
browsers: if that player leaves, another browser takes the list over within a
few seconds.

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
