// Default-role boundary. Phase 3 can supply capabilities without changing Work commands.
export const workCapabilities = user => ({
  execute: user?.status === 'active' && ['operator','admin'].includes(user.role),
  teamView: user?.status === 'active' && user.role === 'admin',
  assign: user?.status === 'active' && user.role === 'admin',
  resolve: user?.status === 'active' && user.role === 'admin',
  timing: user?.status === 'active' && user.role === 'admin',
});
