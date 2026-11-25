/**
 * Where the Draco mesh decoder lives. The venue maps are Draco-compressed
 * (about 4x smaller), and the decoder is served from our own site
 * (public/draco, copied from three/examples/jsm/libs/draco/gltf) rather than
 * drei's default CDN, so the maps load wherever the game does.
 *
 * Every useGLTF call must pass this: drei keeps ONE shared DRACOLoader and
 * each call resets its decoder path, so a call without it would point the
 * loader back at the CDN.
 */
export const DRACO_PATH = `${import.meta.env.BASE_URL}draco/`;
