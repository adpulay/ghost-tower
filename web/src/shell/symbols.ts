// Map symbols shared by the analyst map and the patrol tablet.
// Shapes follow map-symbol convention: a red diamond for the hostile unit (the blaster),
// a blue ring with a crosshair for the friendly intercept point.

export const HOSTILE = "#e5383b";
export const FRIENDLY = "#4a90f0";

export function hostileSvg(size: number): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <path d="M16 2.5 29.5 16 16 29.5 2.5 16Z" fill="${HOSTILE}" stroke="#fff" stroke-width="2.5" stroke-linejoin="miter"/>
    <path d="M16 10v7.5M16 20.5v1.5" stroke="#fff" stroke-width="3"/>
  </svg>`;
}

export function interceptSvg(size: number, colour = FRIENDLY): string {
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">
    <g stroke="#fff" stroke-width="6" fill="none">
      <circle cx="20" cy="20" r="11"/><path d="M20 2v9M20 29v9M2 20h9M29 20h9"/>
    </g>
    <g stroke="${colour}" stroke-width="3" fill="none">
      <circle cx="20" cy="20" r="11"/><path d="M20 2v9M20 29v9M2 20h9M29 20h9"/>
    </g>
    <circle cx="20" cy="20" r="3" fill="${colour}"/>
  </svg>`;
}

export function towerMark(size: number): string {
  // A mast with a cancelled signal: the "ghost" tower.
  return `<svg viewBox="0 0 28 28" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="square">
    <path d="M14 11 9 25M14 11l5 14M10.6 20h6.8"/>
    <path d="M9.2 6.2a6.5 6.5 0 0 0 0 9.2M18.8 6.2a6.5 6.5 0 0 1 0 9.2"/>
    <path d="M4 25 24 3"/>
  </svg>`;
}
