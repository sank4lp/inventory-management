import {verifyRelease} from './pi-package.mjs';
const manifest=verifyRelease(process.argv[2]);
console.log(`Verified LytGuide Test ${manifest.version}: ${manifest.files.length} packaged files.`);
