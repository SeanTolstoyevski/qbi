const service = new Proxy(
  {},
  {
    get(_, method) {
      return (...args) => window.go.main.Service[method](...args);
    },
  },
);

export default service;
