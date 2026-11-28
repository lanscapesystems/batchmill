import assert from 'node:assert/strict';
import { toPortOptions } from './scaleReader.js';

const types: Record<string, string> = { ttyS0: '4', ttyS1: '0' };
const out = toPortOptions([
  { path: '/dev/ttyUSB10' },
  { path: '/dev/ttyUSB2', pnpId: 'usb-FTDI_X-if00-port0', manufacturer: 'FTDI' },
  { path: '/dev/ttyS0' },
  { path: '/dev/ttyS1' }, // phantom UART
  { path: 'COM3', pnpId: 'USB\\VID_0403' }, // Windows pnpId is not a /dev path
], name => types[name] ?? '');

// phantom ttyS1 dropped, stable by-id path preferred on Linux, ttyUSB2 sorted before ttyUSB10
assert.deepEqual(out.map(o => o.path), [
  '/dev/ttyS0', '/dev/serial/by-id/usb-FTDI_X-if00-port0', '/dev/ttyUSB10', 'COM3',
]);
console.log('serialPorts check OK');
