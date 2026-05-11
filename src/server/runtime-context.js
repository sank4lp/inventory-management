let runtimeContext = {
  config: null,
  firmwareService: null,
  logger: null,
  systemService: null,
  startup: null,
};

export function setRuntimeContext(nextContext) {
  runtimeContext = {
    ...runtimeContext,
    ...nextContext,
  };
}

export function getRuntimeContext() {
  return runtimeContext;
}
