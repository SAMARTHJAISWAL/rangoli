import '@fontsource/hind/latin-400.css';
import '@fontsource/hind/latin-500.css';
import '@fontsource/hind/latin-600.css';
import '@fontsource/tiro-devanagari-hindi/devanagari-400.css';
import '@fontsource/tiro-devanagari-hindi/latin-400.css';
import './style.css';
import { App } from './ui/app';

const app = new App();

// A small handle for the end-to-end tests and for curious visitors.
declare global {
  interface Window {
    __rangoli: unknown;
  }
}
window.__rangoli = {
  app,
  fingerprint: () => app.doc.fingerprint(),
  strokes: () => app.doc.visible().length,
  peers: () => app.engine.peerCount(),
};
