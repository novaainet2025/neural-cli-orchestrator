const { execSync } = require('child_process');

describe('Install bridge daemon plist', () => {
  it('--print-plist renders valid XML with escape', () => {
    const output = execSync('node scripts/install-bridge-daemon.mjs --print-plist', { encoding: 'utf8' });
    expect(output).to.contain('&amp;lt;');
    expect(output).to.contain('&amp;gt;');
    expect(output).to.contain('<dict>');
    expect(output).to.contain('<key>Label</key>');
    expect(output).to.contain('com.example.bridge');
  });
});