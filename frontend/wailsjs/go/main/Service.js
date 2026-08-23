const service = new Proxy(
  {},
  {
    get(_, method) {
      return (...args) => window.go.main.Service[method](...args);
    },
  },
);

export const LogFrontend = (...args) => window.go.main.Service.LogFrontend(...args);
export default service;
