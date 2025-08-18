/// <reference types="vite/client" />

declare global {
  interface Window {
    fbq?: (command: string, ...args: unknown[]) => void;
  }
}
