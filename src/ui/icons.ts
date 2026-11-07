import type { Brush } from '../core/types';

/** Small inline icons for the brush buttons (currentColor, 24×24). */
const ICONS: Record<Brush, string> = {
  powder:
    '<path d="M4 16c3-6 7-8 16-10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity=".45"/><g fill="currentColor"><circle cx="5" cy="15" r="1.1"/><circle cx="8" cy="12.6" r=".9"/><circle cx="10.5" cy="11.4" r="1.2"/><circle cx="13.4" cy="9.6" r=".8"/><circle cx="16" cy="8.4" r="1.1"/><circle cx="19" cy="7" r=".9"/><circle cx="7" cy="16.4" r=".7"/><circle cx="12" cy="13" r=".7"/><circle cx="17.6" cy="10" r=".6"/></g>',
  chalk: '<path d="M4 17c4-1 6-9 9-9s3 6 7 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  petal:
    '<g fill="currentColor"><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(0 12 12)"/><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(60 12 12)"/><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(120 12 12)"/><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(180 12 12)"/><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(240 12 12)"/><path d="M12 12c-1-4 0-7 0-9 0 2 1 5 0 9z" transform="rotate(300 12 12)"/></g><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  diya: '<path d="M3 13c1 4 4 6 9 6s8-2 9-6z" fill="currentColor"/><path d="M12 12c-2-2-1.4-5 0-8 1.4 3 2 6 0 8z" fill="currentColor" opacity=".75"/>',
  dot: '<g fill="currentColor"><circle cx="6" cy="6" r="1.8"/><circle cx="12" cy="6" r="1.8"/><circle cx="18" cy="6" r="1.8"/><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/><circle cx="6" cy="18" r="1.8"/><circle cx="12" cy="18" r="1.8"/><circle cx="18" cy="18" r="1.8"/></g>',
};

export const brushIcon = (b: Brush): string => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${ICONS[b]}</svg>`;
