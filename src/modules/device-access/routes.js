import QRCode from 'qrcode';
import {escapeHtml as e} from '../../render.js';
import {templatePage, uiPanel, uiDisclosure, uiFacts} from '../../server/ui.js';
import {sendHtml} from '../../server/http/responses.js';
import {assertCan} from '../access/catalog.js';
import {readDeviceEnrollment, deviceInstructions} from '../../services/device-enrollment.js';

export async function deviceAccessRoutes(request, response, url, user, {read = readDeviceEnrollment} = {}) {
  if (request.method !== 'GET' || !['/settings/connect-device', '/settings/connect-device/root.cer'].includes(url.pathname)) return false;
  assertCan(user, 'system.view');
  let record, error;
  try {
    record = read();
  } catch (cause) {
    error = cause.code === 'ENOENT' ? 'Phone access has not been published on this Pi yet.' : cause.message;
  }
  if (url.pathname.endsWith('/root.cer')) {
    if (!record) {
      sendHtml(response, templatePage({title:'Connect a device', currentPath:'/settings/connect-device', user,
        content:uiPanel('Certificate unavailable', `<p>${e(error)}</p><a class="ui-button" href="/settings/connect-device">Back to device setup</a>`)}), 503);
      return true;
    }
    const bytes = Buffer.from(record.certificate, 'base64');
    response.writeHead(200, {'Content-Type':'application/pkix-cert', 'Content-Disposition':'attachment; filename="LytGuide-shed.cer"', 'Cache-Control':'no-store', 'Content-Length':bytes.length});
    response.end(bytes);
    return true;
  }
  let content;
  if (!record) {
    content = uiPanel('Phone access needs setup', `<p>${e(error)}</p><p>On this Pi, open Shed Setup → Phones &amp; tablets.</p>${uiDisclosure('Using the Git installation?', `<p>Run the updated local-network setup on the Pi once, then refresh this page. Your existing certificate is kept.</p><code>sudo sh scripts/install-pi-lan.sh &lt;Pi IP address&gt;</code>`)}`);
  } else {
    const qr = record.downloadUrl ? await QRCode.toString(record.downloadUrl, {type:'svg', margin:2, width:220}) : null;
    content = uiPanel('Connect a phone or tablet', `${uiFacts([['Shed', e(record.warehouseName)], ['LytGuide address', `<span class="device-enrollment-url">${e(record.appUrl)}</span>`]])}
      <div class="device-enrollment-grid">
        ${qr ? `<div class="device-enrollment-qr" role="img" aria-label="Scan to set up this device">${qr}</div>` : ''}
        <div><ol class="device-enrollment-steps"><li>Join the shed Wi-Fi.</li><li>${qr?'Scan this QR with your phone’s camera.':'Download the certificate here and transfer it to your phone.'}</li><li>Install the certificate, then open LytGuide.</li></ol>
        ${record.downloadUrl ? `<label class="device-enrollment-address">Device setup address<input readonly value="${e(record.downloadUrl)}" aria-label="Device setup address"></label>` : '<p>Reopen Shed Setup → Phones &amp; tablets to enable the QR download page.</p>'}
        <a class="ui-button ui-button-secondary" href="/settings/connect-device/root.cer" download="LytGuide-warehouse.cer">Download certificate here</a></div>
      </div>`)
      + uiPanel('Add to Home Screen', `<p>Open the shed address on your phone. Save a shortcut named after this shed.</p><a class="ui-button" href="${e(record.appUrl)}">Open LytGuide</a>${deviceInstructions()}`)
      + uiDisclosure('Using several sheds', '<p>Install each Pi’s certificate once and save a separate shortcut for each shed. Each Pi has its own address, data and sign-in.</p><p>When several Pis share the same Wi-Fi, choose the shed’s shortcut. Wi-Fi alone cannot select it.</p>')
      + uiDisclosure('Certificate fingerprint', `<p>Compare with the phone before installing.</p><code class="device-enrollment-fingerprint">${e(record.fingerprint)}</code>`);
  }
  sendHtml(response, templatePage({title:'Connect a device', currentPath:'/settings/connect-device', user,
    content:`<link rel="stylesheet" href="/device-enrollment.css"><div class="ui-settings-page device-enrollment">${content}</div>`}));
  return true;
}
