/** Festive names for people in a room: sweets, crackers and lamps. */
export const NAMES = [
  'Kaju Katli', 'Jalebi', 'Laddoo', 'Barfi', 'Gulab Jamun', 'Rasgulla', 'Soan Papdi', 'Peda', 'Gujiya', 'Shakarpara',
  'Chakli', 'Anaar', 'Phuljhadi', 'Chakri', 'Rocket', 'Diya', 'Kandil', 'Toran', 'Marigold', 'Akash Kandil',
  'Mathri', 'Imarti', 'Malpua', 'Kalakand', 'Rabri',
];

export function nameFor(r: () => number): string {
  return NAMES[Math.floor(r() * NAMES.length)]!;
}

/** A stable hue for a name, for cursors and avatars. */
export function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
