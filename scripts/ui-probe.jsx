/**
 * Entrada usada pelo teste de interface em jsdom (scripts/test-youtube-ui.js).
 * É empacotada com esbuild na hora do teste — não faz parte do build de produção.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App.jsx";

export function mount(container) {
  const root = createRoot(container);
  root.render(<App />);
  return root;
}

export { React };
