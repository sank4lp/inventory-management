export function firmwareFailure(error, stage, output = '') {
  const detail = `${error.message}\n${output}`;
  let hint = 'Keep this ESP32 connected by USB. Correct the error, then retry this controller. Saved locations and stock are kept.';
  if (/EACCES|Permission denied|permission.*port/i.test(detail)) hint = 'The app cannot access the USB port. Reconnect the cable and restart LytGuide after installation so serial-port permissions take effect. Close any serial monitor.';
  else if (/ENOENT|No such file|not detected|disconnected|ENODEV|EIO|changed while compiling/i.test(detail)) hint = 'Reconnect this ESP32 with a USB data cable. Detect the port again before retrying; do not select the RS485 adapter.';
  else if (/busy|EBUSY|Resource temporarily unavailable|could not exclusively lock/i.test(detail)) hint = 'Close Arduino IDE, serial monitors and any other controller setup window, then retry with only this ESP32 connected by USB.';
  else if (/ENOSPC|No space left/i.test(detail)) hint = 'Free space on the Pi, then retry. Shed data and saved mappings were kept.';
  else if (/config-storage|config-allocation|invalid-routing|config-revision|config-checksum/i.test(detail)) hint = 'The ESP32 rejected its LED setup. Keep USB connected and retry this controller. If it repeats, check the LED count and use a replacement ESP32; saved shed mappings are kept.';
  else if (/confirmation timed out|configuration reply|checksum|configFault|saved LED setup/i.test(detail)) hint = 'The upload may have succeeded, but the LED setup was not verified. Keep USB connected, close serial monitors and retry this same controller. Do not add it again under another name.';
  else if (stage === 'uploading' || stage === 'identifying') hint = 'Check the USB data cable and selected ESP32 port. If it stays at Connecting, hold BOOT, tap EN/RESET, then release BOOT when upload starts. Retry this controller; do not disconnect USB during upload.';
  else if (stage === 'compiling') hint = 'Firmware could not be built. Check free disk space and reinstall the latest offline LytGuide package if tools are missing. Nothing was uploaded.';
  return {message: error.message, hint};
}
