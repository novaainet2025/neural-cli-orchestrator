#!/bin/bash

# Fetch strategic context from Obsidian knowledge base via NCO API
# This hook is triggered before sending a prompt to the model.

API_URL="http://localhost:6200/api/knowledge/obsidian?query=strategic+alignment"

# Attempt to fetch context with a 2-second timeout
CONTEXT=$(curl -s --max-time 2 "$API_URL" 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$CONTEXT" ] && [[ "$CONTEXT" != '{"error":'* ]]; then
  echo "--- OBSIDIAN STRATEGIC CONTEXT ---"
  echo "$CONTEXT"
  echo "----------------------------------"
fi
