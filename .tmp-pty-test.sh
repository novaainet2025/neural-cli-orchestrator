#!/bin/bash
cd "/Users/nova-ai/project/크롬확장프로그램/cli-extensions"
node tests/pty-inter-session-env.mjs
echo EXIT:$?
