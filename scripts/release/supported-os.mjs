export const SUPPORTED_OS_SUITES=['bookworm','trixie'];
export function supportedOs(os){
  return ['debian','raspbian'].includes(os.ID)&&SUPPORTED_OS_SUITES.includes(os.VERSION_CODENAME);
}
