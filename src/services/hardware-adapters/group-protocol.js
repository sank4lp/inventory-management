// CRC-32/ISO-HDLC, shared with the ESP32 grouped-command decoder.
export function groupChecksum(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, 'ascii')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function groupMask(channels) {
  const digits = Array(64).fill(0);
  for (const channel of channels) {
    if (!Number.isInteger(channel) || channel < 1 || channel > 255) throw new Error('Invalid group output.');
    digits[Math.floor((channel - 1) / 4)] |= 1 << ((channel - 1) % 4);
  }
  return digits.map(n => n.toString(16)).join('');
}
