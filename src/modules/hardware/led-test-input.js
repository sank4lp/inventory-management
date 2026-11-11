export function validateLedTest(input) {
  if (!['text','integer'].includes(input.mode)) throw new Error('Choose Text or Number.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 55 || !/^[\x20-\x21\x23-\x7e]+$/.test(input.text)) throw new Error('Enter 1–55 English letters, numbers or symbols, without double quotes.');
  if (input.mode === 'integer' && (!/^-?\d+$/.test(input.text) || !Number.isSafeInteger(Number(input.text)))) throw new Error('Enter a whole number within the supported safe integer range.');
  if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) throw new Error('Brightness must be a whole number from 0 to 100.');
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('Choose a valid colour.');
  return input;
}
