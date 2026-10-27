// Match esp32-simple-matrix: W=8, CHAR_ADVANCE_SCROLL=7.
export const MIXED_PRODUCT_COLORS=Object.freeze(['cyan','white','pink']);
export const DISPLAY_TICK_MS=100;
export function mixedQuantityTiming(value){
  const text=String(value);
  if(!/^\d{1,3}$/.test(text))throw new Error('Mixed quantities must be whole numbers from 0 to 999.');
  return {scrollOnce:true,scrollSpeedMs:120,durationMs:text.length===1?4000:(8+text.length*7+1)*120};
}
