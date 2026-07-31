import { escapeXML } from './xml-utils.js';
import { ThrottleInterval = 10 } from 'config';

export function installDaemon({ printPlist = false }) {
  if (printPlist) {
    const plist = renderPlist();
    console.log(plist);
    return;
  }

  // Existing installation logic (does NOT modify files)
}

function renderPlist() {
  const plist = {
    Label: 'com.example.bridge',
    ProgramArguments: [process.execPath, 'bridge-daemon'],
    RunAtLoad: true,
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${escapeXML(plist.Label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${plist.ProgramArguments.map(arg => `    <string>${escapeXML(arg)}</string>`).join('\n')}\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${escapeXML(plist.StandardOutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${escapeXML(plist.StandardErrorPath)}</string>\n</dict>\n</plist>`;
}

// XML escape helper
function escapeXML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}