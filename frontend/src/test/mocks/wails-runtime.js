export const EventsOn = (...args) =>
  window.runtime.EventsOnMultiple(...args, -1);
export const EventsOff = (...args) => window.runtime.EventsOff(...args);
export const BrowserOpenURL = (...args) =>
  window.runtime.BrowserOpenURL(...args);
