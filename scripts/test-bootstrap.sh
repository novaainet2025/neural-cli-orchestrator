#!/usr/bin/env bash

# Test script for bootstrap.sh

set -e

# Setup test environment
TEST_DIR=$(mktemp -d)
echo "Running tests in $TEST_DIR"
cd "$TEST_DIR"

# Create mock bin directory
mkdir bin
export PATH="$TEST_DIR/bin:$PATH"

# Mock git
cat << 'EOF' > bin/git
#!/usr/bin/env bash
echo "Mock git called with: $@"
if [[ "$1" == "clone" ]]; then
    mkdir -p "$3"
    mkdir -p "$3/.git"
    echo '{"name": "neural-cli-orchestrator"}' > "$3/package.json"
elif [[ "$1" == "diff-index" ]]; then
    exit 0 # No changes
fi
exit 0
EOF
chmod +x bin/git

# Mock npm
cat << 'EOF' > bin/npm
#!/usr/bin/env bash
echo "Mock npm called with: $@"
exit 0
EOF
chmod +x bin/npm

# Mock pm2
cat << 'EOF' > bin/pm2
#!/usr/bin/env bash
echo "Mock pm2 called with: $@"
exit 0
EOF
chmod +x bin/pm2

# Mock curl
cat << 'EOF' > bin/curl
#!/usr/bin/env bash
echo "Mock curl called with: $@"
if [[ "$1" == "-s" && "$2" == "http://localhost:6200/health" ]]; then
    echo '{"status":"healthy"}'
    exit 0
fi
exit 0
EOF
chmod +x bin/curl

# Copy bootstrap to test dir
cp /Users/nova-ai/project/nco/bootstrap.sh .

echo "--- Running bootstrap.sh in empty directory (Clone test) ---"
./bootstrap.sh

# Now simulate already cloned dir
echo "--- Running bootstrap.sh in existing directory (Update test) ---"
cd neural-cli-orchestrator
# Create .env to test preserving it
echo "PORT=9999" > .env
../bootstrap.sh

echo "All tests passed successfully!"
rm -rf "$TEST_DIR"
