import {groupChecksum} from './group-protocol.js';

// Builds a complete configuration for the future controller-edit workflow.
// Delivery must be reconciled with config-status before database mappings commit.
export function encodeControllerConfiguration({address, requestId, expectedRevision, physicalCount, routing}) {
  if (typeof address !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(address) || /^(all|broadcast)$/i.test(address)) throw new Error('Use the exact controller address.');
  if (!/^[a-f0-9]{16}$/.test(requestId)) throw new Error('Invalid configuration request ID.');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 0xffffffff) throw new Error('Invalid configuration revision.');
  if (!Number.isInteger(physicalCount) || physicalCount < 0 || physicalCount > 64) throw new Error('Physical module count must be 0–64.');
  if (!Array.isArray(routing) || routing.length !== 64) throw new Error('Provide all 64 logical output slots.');
  const used = new Set();
  for (const physical of routing) {
    if (!Number.isInteger(physical) || physical < 0 || physical > physicalCount || physical && used.has(physical)) throw new Error('Invalid or duplicate physical output.');
    if (physical) used.add(physical);
  }
  if (used.size !== physicalCount) throw new Error('Every physical output must have a logical slot.');
  const map = routing.map(n => n.toString(16).padStart(2,'0')).join('');
  const payload = `${requestId} ${expectedRevision.toString(16).padStart(8,'0')} ${physicalCount} ${map}`;
  const crc = groupChecksum(`${address.toUpperCase()} configure ${payload}`);
  return `to ${address} configure ${payload} ${crc}`;
}
